import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrderState, PriceTier, RefundReason, SeatHoldOrigin, SeatHoldState } from '@arthome/core';

import {
  DUE_INTENT_CANCELLATIONS_SQL,
  DUE_REFUNDS_SQL,
  LOST_REFUNDS_SQL,
  RERUN_ASKED_REFUNDS_SQL,
  RELAY_BATCH,
} from './owed-call-relay.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';

/**
 * The relay's two claims run every second over tables that only grow: each reads its rows by its
 *   partial index (HANDOVER §0m), never every refund made or every order placed.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const HISTORY = 20_000;
const DATE = '01a0f730-0000-7000-8000-000000000001';
const HOLD = '01a0f730-0000-7000-8000-0000000000b1';
const NOW = new Date('2026-10-06T10:00:00.000Z');

let stack: StartedStack;
let dataSource: DataSource;

async function planOf(sql: string, parameters: unknown[]): Promise<string> {
  const plan = await dataSource.query<{ 'QUERY PLAN': string }[]>(`EXPLAIN ${sql}`, parameters);
  return plan.map((line) => line['QUERY PLAN']).join('\n');
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_relay_plan_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  await dataSource.query(
    `INSERT INTO date_sales (date_id, channel_id, capacity_total, capacity_tiers, seats_available,
                             seats_sold, waitlist_count, price_tiers, prices_locked_at, version)
     VALUES ($1, 'channel-plan', 10, '[]', 10, 0, 0, '[]', now(), 2)`,
    [DATE],
  );
  await dataSource.query(
    `INSERT INTO seat_hold (id, date_id, tier, quantity, origin, origin_ref, expires_at, state,
                            version)
     VALUES ($1, $2, $3, 1, $4, $1, $5, $6, 2)`,
    [HOLD, DATE, PriceTier.FULL, SeatHoldOrigin.CHECKOUT, NOW, SeatHoldState.CONSUMED],
  );
  await dataSource.query(
    `INSERT INTO seat_order (id, reference, idempotency_key, fingerprint, date_id, channel_id,
                             tier, quantity, currency_code, unit_price_minor, tier_total_minor,
                             service_fee_minor, discount_minor, total_minor, hold_id, expires_at,
                             state, placed_at, version, payment_intent_ref)
     SELECT ('01a0f7aa-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, 'ATH-PLAN-' || n,
            gen_random_uuid(), 'plan', $1, 'channel-plan', $2, 1, 'EUR', 2400, 2400, 0, 0, 2400,
            $3, $4, $5, $4, 3, 'pi_plan_' || n
       FROM generate_series(1, $6::int) AS n`,
    [DATE, PriceTier.FULL, HOLD, NOW, OrderState.REFUNDED, HISTORY],
  );
  await dataSource.query(
    `INSERT INTO order_refund (id, order_id, amount_minor, currency_code, reason, idempotency_key,
                               owed_at, enqueued_at, refund_ref, refunded_at)
     SELECT gen_random_uuid(), ('01a0f7aa-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
            2400, 'EUR', $1, 'refund:plan-' || n, $2, $2, 're_plan_' || n, $2
       FROM generate_series(1, $3::int) AS n`,
    [RefundReason.GOODWILL, NOW, HISTORY],
  );
  await dataSource.query(
    `UPDATE order_refund SET refunded_at = NULL, refund_ref = NULL, enqueued_at = NULL
      WHERE idempotency_key IN ('refund:plan-1', 'refund:plan-2')`,
  );
  await dataSource.query(
    `UPDATE seat_order SET state = $1, intent_cancel_owed_at = $2
      WHERE reference IN ('ATH-PLAN-3', 'ATH-PLAN-4')`,
    [OrderState.FAILED, NOW],
  );
  await dataSource.query('ANALYZE order_refund');
  await dataSource.query('ANALYZE seat_order');
}, STARTUP_MS);

afterAll(async () => {
  await dataSource?.destroy();
  await stack?.stop();
});

describe("the relay's claims", () => {
  it(
    `read no order_refund sequentially over ${String(HISTORY)} refunds made`,
    async () => {
      for (const plan of [
        await planOf(DUE_REFUNDS_SQL, [RELAY_BATCH]),
        await planOf(LOST_REFUNDS_SQL, [NOW, NOW, RELAY_BATCH]),
      ]) {
        expect(plan).not.toMatch(/Seq Scan on order_refund/);
        expect(plan).toMatch(/idx_order_refund_due/);
      }
      const reruns = await planOf(RERUN_ASKED_REFUNDS_SQL, [RELAY_BATCH]);
      expect(reruns).not.toMatch(/Seq Scan on order_refund/);
      expect(reruns).toMatch(/idx_order_refund_rerun_asked/);
    },
    CASE_MS,
  );

  it(
    `read no seat_order sequentially over ${String(HISTORY)} orders owing no cancellation`,
    async () => {
      const plan = await planOf(DUE_INTENT_CANCELLATIONS_SQL, [NOW, RELAY_BATCH]);

      expect(plan).not.toMatch(/Seq Scan on seat_order/);
      expect(plan).toMatch(/idx_seat_order_intent_cancel_due/);
    },
    CASE_MS,
  );
});
