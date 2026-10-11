import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DateOutcome, SeatHoldState, SeatState } from '@arthome/core';

import { MOVE_SEAT_CANCEL_DEADLINES } from './outcome-facts.js';
import {
  CLAIM_SETTLEMENT,
  DUE_SETTLEMENTS,
  NOTHING_LEFT_TO_SETTLE,
  ORDERS_TO_SETTLE,
} from './settle-date-outcomes.handler.js';
import { seedPaidOrders } from '../itest/paid-orders.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';

/**
 * The settlement pass's statements on filled tables (R16, the review checklist's last row): over
 *   50,000 seats on 100 dates and 20,000 dates settled before, each reads by index, `seat`
 *   through `idx_seat_date_active`.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 120_000;

const NOW = '2026-10-05T10:00:00.000Z';
const CHANNEL = '01a0e80c-0000-7000-8000-000000000001';
const DATES = 100;
const ORDERS_PER_DATE = 250;
const SEATS_PER_ORDER = 2;
const SETTLED_BEFORE = 20_000;

let stack: StartedStack;
let dataSource: DataSource;

const dateIdOf = (n: number): string => `01a0e800-0000-7000-8000-${String(n).padStart(12, '0')}`;

async function planOf(sql: string, parameters: unknown[]): Promise<string> {
  const plan = await dataSource.query<{ 'QUERY PLAN': string }[]>(`EXPLAIN ${sql}`, parameters);
  return plan.map((line) => line['QUERY PLAN']).join('\n');
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_settlement_plan_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
}, STARTUP_MS);

afterAll(async () => {
  await dataSource?.destroy();
  await stack?.stop();
});

describe('the settlement pass on filled tables', () => {
  it(
    "reads every table by index, a date's seats through idx_seat_date_active",
    async () => {
      await dataSource.query(
        `INSERT INTO date_sales (date_id, channel_id, capacity_total, capacity_tiers,
                                 seats_available, seats_sold, waitlist_count, price_tiers,
                                 prices_locked_at, sales_closed_at, outcome, outcome_stated_at,
                                 version)
         SELECT ('01a0e8ff-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, $1, 10, '[]', 10,
                0, 0, '[]', $2, $2, $3, $2, 3
           FROM generate_series(1, $4) AS n`,
        [CHANNEL, new Date(NOW), DateOutcome.CANCELLED, SETTLED_BEFORE],
      );
      await dataSource.query(
        `INSERT INTO date_outcome_settlement (date_id, outcome, recorded_at, waitlist_ended_at,
                                              settled_at)
         SELECT date_id, outcome, $1, $1, $1 FROM date_sales`,
        [new Date(NOW)],
      );
      await dataSource.query(
        `INSERT INTO date_sales (date_id, channel_id, capacity_total, capacity_tiers,
                                 seats_available, seats_sold, waitlist_count, price_tiers,
                                 prices_locked_at, sales_closed_at, outcome, outcome_stated_at,
                                 version)
         SELECT ('01a0e800-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, $1, 10, '[]', 10,
                0, 0, '[]', $2, $2, $3, $2, 3
           FROM generate_series(1, $4) AS n`,
        [CHANNEL, new Date(NOW), DateOutcome.CANCELLED, DATES],
      );
      await dataSource.query(
        `INSERT INTO date_outcome_settlement (date_id, outcome, recorded_at)
         SELECT date_id, outcome, $1 FROM date_sales WHERE date_id::text LIKE '01a0e800-%'`,
        [new Date(NOW)],
      );
      for (let n = 1; n <= DATES; n += 1) {
        await seedPaidOrders(dataSource, {
          dateId: dateIdOf(n),
          channelId: CHANNEL,
          series: `01a0e8${n.toString(16).padStart(2, '0')}`,
          quantities: Array.from({ length: ORDERS_PER_DATE }, () => SEATS_PER_ORDER),
          accountId: null,
          cancelDeadline: null,
          paidAt: NOW,
        });
      }
      await dataSource.query(
        `UPDATE seat_hold SET state = $2
          WHERE id IN (SELECT id FROM seat_hold WHERE date_id = $1 LIMIT 3)`,
        [dateIdOf(1), SeatHoldState.ACTIVE],
      );
      const [seats] = await dataSource.query<{ seats: number }[]>(
        'SELECT count(*)::int AS seats FROM seat',
      );
      expect(seats?.seats).toBe(DATES * ORDERS_PER_DATE * SEATS_PER_ORDER);
      await dataSource.query('ANALYZE');
      const dateId = dateIdOf(42);

      const plans = {
        due: await planOf(DUE_SETTLEMENTS, [new Date(NOW), 10, SeatState.ACTIVE]),
        claim: await planOf(CLAIM_SETTLEMENT, [dateId]),
        orders: await planOf(ORDERS_TO_SETTLE, [dateId, 500, SeatState.ACTIVE]),
        settled: await planOf(NOTHING_LEFT_TO_SETTLE, [
          dateId,
          SeatState.ACTIVE,
          SeatHoldState.ACTIVE,
        ]),
        postponed: await planOf(MOVE_SEAT_CANCEL_DEADLINES, [
          dateId,
          new Date(NOW),
          new Date(NOW),
          SeatState.ACTIVE,
        ]),
      };

      for (const [statement, plan] of Object.entries(plans)) {
        expect(plan, `${statement}:\n${plan}`).not.toMatch(/Seq Scan/);
      }
      expect(plans.orders).toMatch(/idx_seat_date_active/);
      expect(plans.settled).toMatch(/idx_seat_date_active/);
      expect(plans.settled).toMatch(/idx_seat_hold_active_date/);
      expect(plans.postponed).toMatch(/idx_seat_date_active/);
      expect(plans.due).toMatch(/idx_date_outcome_settlement_due/);
    },
    CASE_MS,
  );
});
