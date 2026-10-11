import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SeatState } from '@arthome/core';

import { READ_ENTITLEMENT_FACTS } from './entitlement-facts.js';
import { STREAMING_SCHEMA } from '../itest/schema.js';

/**
 * The entitlement read on filled tables (the review checklist's last row): over 200,000 seats on
 *   2,000 dates, the counts read through `idx_entitlement_seat_account_date`, the date and the
 *   subscription by their keys.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 120_000;

const SEATS = 200_000;
const DATES = 2_000;
const ACCOUNTS = 50_000;

let stack: StartedStack;
let dataSource: DataSource;

const idOf = (prefix: string, n: number): string =>
  `${prefix}-0000-7000-8000-${String(n).padStart(12, '0')}`;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'streaming_seat_counts_plan_itest');
  dataSource = await applyMigrations(database, STREAMING_SCHEMA);
}, STARTUP_MS);

afterAll(async () => {
  await dataSource?.destroy();
  await stack?.stop();
});

describe('the entitlement read on filled tables', () => {
  it(
    "counts an account's seats on a date through idx_entitlement_seat_account_date",
    async () => {
      await dataSource.query(
        `INSERT INTO entitlement_seat (seat_id, account_id, date_id, state, occurred_at, applied_at)
         SELECT ('01a0f550-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
                ('01a0f551-0000-7000-8000-' || lpad((n % $1)::text, 12, '0'))::uuid,
                ('01a0f552-0000-7000-8000-' || lpad((n % $2)::text, 12, '0'))::uuid,
                CASE WHEN n % 10 = 0 THEN $4 ELSE $5 END, now(), now()
           FROM generate_series(1, $3) AS n`,
        [ACCOUNTS, DATES, SEATS, SeatState.CANCELLED, SeatState.ACTIVE],
      );
      await dataSource.query(
        `INSERT INTO entitlement_date (date_id, channel_id, applied_at)
         SELECT ('01a0f552-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, 'channel', now()
           FROM generate_series(0, $1 - 1) AS n`,
        [DATES],
      );
      await dataSource.query(
        `INSERT INTO entitlement_subscription (account_id, openings, occurred_at, applied_at)
         SELECT ('01a0f551-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, '{}', now(), now()
           FROM generate_series(0, $1 - 1, 5) AS n`,
        [ACCOUNTS],
      );
      await dataSource.query(
        'ANALYZE entitlement_seat, entitlement_date, entitlement_subscription',
      );

      const plan = await dataSource.query<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN ${READ_ENTITLEMENT_FACTS}`,
        [idOf('01a0f551', 7), idOf('01a0f552', 7)],
      );
      const lines = plan.map((line) => line['QUERY PLAN']).join('\n');

      expect(lines).toContain('idx_entitlement_seat_account_date');
      expect(lines).toContain('entitlement_date_pkey');
      expect(lines).toContain('entitlement_subscription_pkey');
      expect(lines).not.toMatch(/Seq Scan/);
    },
    CASE_MS,
  );
});
