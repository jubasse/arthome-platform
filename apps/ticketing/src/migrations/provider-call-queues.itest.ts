import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrderState, PriceTier, RefundReason, SeatHoldOrigin, SeatHoldState } from '@arthome/core';

import { ProviderCallQueues1790441200000 } from './1790441200000-provider-call-queues.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { DUE_INTENT_CANCELLATIONS_SQL, DUE_REFUNDS_SQL } from '../payments/owed-call-relay.js';

/**
 * `ProviderCallQueues1790441200000` on a database that already owes and made refunds, as the stack
 *   did: one `order_refund` per order that owed one, under the key the provider knows, the owed
 *   ones due to the relay after it; an owed cancellation due too; and `down` putting them back.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const DATE = '01a0f720-0000-7000-8000-000000000001';
const HOLD = '01a0f720-0000-7000-8000-0000000000b1';
const OWED = '01a0f720-0000-7000-8000-0000000000a1';
const MADE = '01a0f720-0000-7000-8000-0000000000a2';
const DEAD = '01a0f720-0000-7000-8000-0000000000a3';
const CANCEL = '01a0f720-0000-7000-8000-0000000000a4';
const PAID = '01a0f720-0000-7000-8000-0000000000a5';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const OWED_AT = new Date('2026-10-01T10:00:00.000Z');
const LATER = new Date('2026-10-01T10:05:00.000Z');

let stack: StartedStack;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
}, STARTUP_MS);

afterAll(async () => {
  await stack?.stop();
});

async function seed(before: DataSource): Promise<void> {
  await before.query(
    `INSERT INTO date_sales (date_id, channel_id, capacity_total, capacity_tiers, seats_available,
                             seats_sold, waitlist_count, price_tiers, prices_locked_at, version)
     VALUES ($1, 'channel-queues', 10, '[]', 10, 0, 0, '[]', now(), 2)`,
    [DATE],
  );
  await before.query(
    `INSERT INTO seat_hold (id, date_id, tier, quantity, origin, origin_ref, expires_at, state,
                            version)
     VALUES ($1, $2, $3, 1, $4, $1, $5, $6, 2)`,
    [HOLD, DATE, PriceTier.FULL, SeatHoldOrigin.CHECKOUT, OWED_AT, SeatHoldState.EXPIRED],
  );
  const orders: [string, string, string][] = [
    [OWED, OrderState.FAILED, 'ATH-2026-90001'],
    [MADE, OrderState.REFUNDED, 'ATH-2026-90002'],
    [DEAD, OrderState.FAILED, 'ATH-2026-90003'],
    [CANCEL, OrderState.FAILED, 'ATH-2026-90004'],
    [PAID, OrderState.PAID, 'ATH-2026-90005'],
  ];
  for (const [id, state, reference] of orders) {
    await before.query(
      `INSERT INTO seat_order (id, reference, idempotency_key, fingerprint, date_id, channel_id,
                               tier, quantity, currency_code, unit_price_minor, tier_total_minor,
                               service_fee_minor, discount_minor, total_minor, hold_id,
                               expires_at, state, placed_at, version, payment_intent_ref)
       VALUES ($1, $2, $1, 'queues', $3, 'channel-queues', $4, 2, 'EUR', 2400, 4800, 0, 0, 4800,
               $5, $6, $7, $6, 3, $8)`,
      [id, reference, DATE, PriceTier.FULL, HOLD, OWED_AT, state, `pi_queues_${reference}`],
    );
  }
  const unseated = RefundReason.HOLD_EXPIRED_CAPACITY_LOST;
  await before.query(
    `UPDATE seat_order SET refund_reason = $2, refund_owed_at = $3, refund_traceparent = $4,
                           refund_attempts = 3, refund_next_attempt_at = $5
      WHERE id = $1`,
    [OWED, unseated, OWED_AT, TRACEPARENT, LATER],
  );
  await before.query(
    `UPDATE seat_order SET refund_reason = $2, refund_owed_at = $3, refund_ref = 're_fake_made',
                           refunded_at = $4, refund_attempts = 1
      WHERE id = $1`,
    [MADE, unseated, OWED_AT, LATER],
  );
  await before.query(
    `UPDATE seat_order SET refund_reason = $2, refund_owed_at = $3, refund_dead_at = $4,
                           refund_attempts = 34
      WHERE id = $1`,
    [DEAD, unseated, OWED_AT, LATER],
  );
  await before.query(
    `UPDATE seat_order SET intent_cancel_owed_at = $2, intent_cancel_attempts = 2,
                           intent_cancel_next_attempt_at = $3
      WHERE id = $1`,
    [CANCEL, OWED_AT, LATER],
  );
}

describe('the provider-call queues migration', () => {
  it(
    'moves each refund to its own row under the key the provider knows, the owed ones due after',
    async () => {
      const database = await createDatabase(stack.postgres, 'ticketing_provider_calls_migration');
      const { entities, migrations } = TICKETING_SCHEMA;
      if (!Array.isArray(migrations)) throw new Error('the schema lists its migrations');
      const before = await applyMigrations(database, {
        entities,
        migrations: migrations.filter((migration) => migration !== ProviderCallQueues1790441200000),
      });
      try {
        await seed(before);
      } finally {
        await before.destroy();
      }

      const after = await applyMigrations(database, TICKETING_SCHEMA);
      try {
        const refunds = await after.query<Record<string, unknown>[]>(
          `SELECT order_id, seat_id, amount_minor, currency_code, reason, idempotency_key, owed_at,
                  traceparent, enqueued_at, refund_ref, refunded_at, dead_at
             FROM order_refund ORDER BY order_id`,
        );
        const unseated = RefundReason.HOLD_EXPIRED_CAPACITY_LOST;
        const common = {
          seat_id: null,
          amount_minor: '4800',
          currency_code: 'EUR',
          reason: unseated,
          owed_at: OWED_AT,
          enqueued_at: null,
        };
        expect(refunds).toEqual([
          {
            ...common,
            order_id: OWED,
            idempotency_key: `refund:${OWED}`,
            traceparent: TRACEPARENT,
            refund_ref: null,
            refunded_at: null,
            dead_at: null,
          },
          {
            ...common,
            order_id: MADE,
            idempotency_key: `refund:${MADE}`,
            traceparent: null,
            refund_ref: 're_fake_made',
            refunded_at: LATER,
            dead_at: null,
          },
          {
            ...common,
            order_id: DEAD,
            idempotency_key: `refund:${DEAD}`,
            traceparent: null,
            refund_ref: null,
            refunded_at: null,
            dead_at: LATER,
          },
        ]);

        const columns = await after.query<{ column_name: string }[]>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_name = 'seat_order'
              AND (column_name LIKE 'refund%' OR column_name LIKE 'intent_cancel%')
            ORDER BY column_name`,
        );
        expect(columns.map(({ column_name }) => column_name)).toEqual([
          'intent_cancel_dead_at',
          'intent_cancel_enqueued_at',
          'intent_cancel_owed_at',
        ]);

        await after.transaction(async (manager) => {
          const dueRefunds = await manager.query<{ idempotency_key: string }[]>(
            DUE_REFUNDS_SQL,
            [500],
          );
          expect(dueRefunds.map(({ idempotency_key }) => idempotency_key)).toEqual([
            `refund:${OWED}`,
          ]);
          const dueCancellations = await manager.query<{ id: string }[]>(
            DUE_INTENT_CANCELLATIONS_SQL,
            [LATER, 500],
          );
          expect(dueCancellations).toEqual([{ id: CANCEL }]);
        });

        await after.undoLastMigration({ transaction: 'each' });
        const restored = await after.query<Record<string, unknown>[]>(
          `SELECT id, refund_reason, refund_owed_at, refund_ref, refunded_at, refund_dead_at,
                  refund_traceparent, intent_cancel_owed_at
             FROM seat_order ORDER BY id`,
        );
        expect(restored).toEqual([
          {
            id: OWED,
            refund_reason: unseated,
            refund_owed_at: OWED_AT,
            refund_ref: null,
            refunded_at: null,
            refund_dead_at: null,
            refund_traceparent: TRACEPARENT,
            intent_cancel_owed_at: null,
          },
          {
            id: MADE,
            refund_reason: unseated,
            refund_owed_at: OWED_AT,
            refund_ref: 're_fake_made',
            refunded_at: LATER,
            refund_dead_at: null,
            refund_traceparent: null,
            intent_cancel_owed_at: null,
          },
          {
            id: DEAD,
            refund_reason: unseated,
            refund_owed_at: OWED_AT,
            refund_ref: null,
            refunded_at: null,
            refund_dead_at: LATER,
            refund_traceparent: null,
            intent_cancel_owed_at: null,
          },
          {
            id: CANCEL,
            refund_reason: null,
            refund_owed_at: null,
            refund_ref: null,
            refunded_at: null,
            refund_dead_at: null,
            refund_traceparent: null,
            intent_cancel_owed_at: OWED_AT,
          },
          {
            id: PAID,
            refund_reason: null,
            refund_owed_at: null,
            refund_ref: null,
            refunded_at: null,
            refund_dead_at: null,
            refund_traceparent: null,
            intent_cancel_owed_at: null,
          },
        ]);
      } finally {
        await after.destroy();
      }
    },
    CASE_MS,
  );
});
