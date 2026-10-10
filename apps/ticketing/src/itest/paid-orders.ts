import type { DataSource } from 'typeorm';

import {
  OrderState,
  PriceTier,
  SeatHoldOrigin,
  SeatHoldState,
  SeatState,
  type Instant,
} from '@arthome/core';

import { FULL_PRICE_MINOR } from './sales.js';

export interface PaidOrders {
  readonly dateId: string;
  readonly channelId: string;
  /** Eight hex digits naming the series: the orders are `{series}-0000-7000-8000-{n}`. */
  readonly series: string;
  /** One order per entry, of that many full-price seats. */
  readonly quantities: readonly number[];
  readonly accountId: string | null;
  readonly cancelDeadline: Instant | null;
  readonly paidAt: Instant;
}

export function seededOrderId(series: string, n: number): string {
  return `${series}-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

/**
 * Paid orders as a payment leaves them, by the thousand: each hold consumed, the order paid
 *   through the fake's intent of its id, its seats active. The date's counters are not moved.
 */
export async function seedPaidOrders(dataSource: DataSource, seed: PaidOrders): Promise<string[]> {
  const { dateId, channelId, series, quantities, accountId, cancelDeadline, paidAt } = seed;
  const numbered = `SELECT n, ($1 || '-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid AS order_id,
                           ($1 || '-0000-7000-9000-' || lpad(n::text, 12, '0'))::uuid AS hold_id,
                           ($2::int[])[n] AS quantity
                      FROM generate_series(1, cardinality($2::int[])) AS n`;
  await dataSource.transaction(async (manager) => {
    await manager.query(
      `INSERT INTO seat_hold (id, date_id, account_id, tier, quantity, origin, origin_ref,
                              expires_at, state, version)
       SELECT hold_id, $3, $4, $5, quantity, $6, order_id, $7, $8, 2 FROM (${numbered}) AS o`,
      [
        series,
        quantities,
        dateId,
        accountId,
        PriceTier.FULL,
        SeatHoldOrigin.CHECKOUT,
        new Date(paidAt),
        SeatHoldState.CONSUMED,
      ],
    );
    await manager.query(
      `INSERT INTO seat_order (id, reference, idempotency_key, account_id, fingerprint, date_id,
                               channel_id, tier, quantity, currency_code, unit_price_minor,
                               tier_total_minor, service_fee_minor, discount_minor, total_minor,
                               hold_id, expires_at, state, payment_intent_ref, placed_at, paid_at,
                               version)
       SELECT order_id, 'ATH-SEED-' || $1 || '-' || n, gen_random_uuid(), $4, 'seeded', $3, $5, $6,
              quantity, 'EUR', $7::bigint, $7::bigint * quantity, 0, 0, $7::bigint * quantity, hold_id, $8, $9,
              'pi_fake_' || replace(order_id::text, '-', ''), $8, $8, 3
         FROM (${numbered}) AS o`,
      [
        series,
        quantities,
        dateId,
        accountId,
        channelId,
        PriceTier.FULL,
        FULL_PRICE_MINOR,
        new Date(paidAt),
        OrderState.PAID,
      ],
    );
    await manager.query(
      `INSERT INTO seat (id, order_id, date_id, account_id, tier, seat_code, state,
                         cancel_deadline, activated_at)
       SELECT ($1 || '-0000-7000-a000-' || lpad((n * 10 + k)::text, 12, '0'))::uuid, order_id,
              $3, $4, $5, 'IT' || $1 || '-' || n || '-' || k, $6, $7, $8
         FROM (${numbered}) AS o CROSS JOIN LATERAL generate_series(1, quantity) AS k`,
      [
        series,
        quantities,
        dateId,
        accountId,
        PriceTier.FULL,
        SeatState.ACTIVE,
        cancelDeadline === null ? null : new Date(cancelDeadline),
        new Date(paidAt),
      ],
    );
  });
  return quantities.map((_, index) => seededOrderId(series, index + 1));
}
