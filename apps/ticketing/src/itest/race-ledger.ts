import {
  SeatCancelledSchema,
  SeatCancelReason as WireSeatCancelReason,
} from '@arthome-platform/events';
import { RefusalException, domainRefusal } from '@arthome-platform/http-edge';
import { OutboxEvent } from '@arthome-platform/messaging';
import { fromBinary } from '@bufbuild/protobuf';
import type { DataSource } from 'typeorm';
import { expect } from 'vitest';

import { SeatCancelReason, SeatHoldState, isDomainError } from '@arthome/core';

import type { FakePaymentProvider } from '../payments/fake-payment-provider.js';

export const times = (count: number, task: () => Promise<unknown>): (() => Promise<unknown>)[] =>
  Array.from({ length: count }, () => task);

function refusalCodeOf(error: unknown): string | null {
  if (error instanceof RefusalException) return error.refusal.code;
  if (isDomainError(error)) return domainRefusal(error).refusal.code;
  return null;
}

/**
 * Every task started at once; none may reject but with one of the refusals `expected`, the answers
 *   a racer loses with. Answers how many were refused.
 */
export async function raced(
  tasks: readonly (() => Promise<unknown>)[],
  expected: readonly string[] = [],
): Promise<number> {
  const settled = await Promise.allSettled(tasks.map((task) => task()));
  const refused = settled.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );
  for (const { reason } of refused) {
    const code = refusalCodeOf(reason);
    if (code === null || !expected.includes(code)) throw reason;
  }
  return refused.length;
}

export interface OrderLedger {
  readonly id: string;
  readonly state: string;
  readonly total_minor: string;
  readonly refunds: { reason: string; amount_minor: string; made: boolean; dead: boolean }[];
  readonly seats: number;
}

export async function ordersOf(
  dataSource: DataSource,
  dateId: string,
): Promise<Map<string, OrderLedger>> {
  const rows = await dataSource.query<OrderLedger[]>(
    `SELECT placed.id, placed.state, placed.total_minor,
            coalesce((SELECT json_agg(json_build_object('reason', refund.reason,
                                                        'amount_minor', refund.amount_minor::text,
                                                        'made', refund.refunded_at IS NOT NULL,
                                                        'dead', refund.dead_at IS NOT NULL)
                                      ORDER BY refund.owed_at, refund.id)
                        FROM order_refund AS refund WHERE refund.order_id = placed.id),
                     '[]') AS refunds,
            (SELECT count(*)::int FROM seat WHERE seat.order_id = placed.id) AS seats
       FROM seat_order AS placed WHERE placed.date_id = $1`,
    [dateId],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

export const madeTotalOf = ({ refunds }: OrderLedger): number =>
  refunds
    .filter(({ made }) => made)
    .reduce((sum, { amount_minor }) => sum + Number(amount_minor), 0);

export function outboxOf(
  dataSource: DataSource,
  aggregateId: string,
  type: string,
): Promise<OutboxEvent[]> {
  return dataSource.getRepository(OutboxEvent).findBy({ aggregateid: aggregateId, type });
}

/** Each seat's `seat.cancelled` reasons, in no particular order. */
export async function seatCancellationsPerSeat(
  dataSource: DataSource,
  dateId: string,
): Promise<Map<string, string[]>> {
  const perSeat = new Map<string, string[]>();
  for (const row of await outboxOf(dataSource, dateId, 'ticketing.seat.cancelled.v1')) {
    const event = fromBinary(SeatCancelledSchema, row.payload);
    perSeat.set(event.seatId, [
      ...(perSeat.get(event.seatId) ?? []),
      WireSeatCancelReason[event.reason],
    ]);
  }
  return perSeat;
}

export function seatsOf(dataSource: DataSource, dateId: string) {
  return dataSource.query<
    { id: string; order_id: string; state: string; cancel_reason: string | null }[]
  >('SELECT id, order_id, state, cancel_reason FROM seat WHERE date_id = $1 ORDER BY id', [dateId]);
}

/**
 * The ledger after a race: available, pooled (PT3), held and sold seats adding up to the capacity,
 *   one `seat` row per seat sold (a viewer's cancellation on a date still running gives its seat
 *   back to sale), refunds never above what the order paid, and each refund made once at the provider,
 *   under its key, for the amount its row owes.
 */
export async function expectLedgerHolds(
  dataSource: DataSource,
  fake: FakePaymentProvider,
  dateId: string,
): Promise<void> {
  const [ledger] = await dataSource.query<
    {
      capacity: number;
      available: number;
      pooled: number;
      sold: number;
      held: number;
      seats: number;
      back_on_sale: number;
    }[]
  >(
    `SELECT sales.capacity_total AS capacity, sales.seats_available AS available,
            sales.priority_pool_seats AS pooled,
            sales.seats_sold AS sold,
            (SELECT coalesce(sum(quantity), 0)::int FROM seat_hold
              WHERE date_id = $1 AND state = $2) AS held,
            (SELECT count(*)::int FROM seat WHERE date_id = $1) AS seats,
            (SELECT count(*)::int FROM seat
              WHERE date_id = $1 AND cancel_reason = $3) AS back_on_sale
       FROM date_sales AS sales WHERE sales.date_id = $1`,
    [dateId, SeatHoldState.ACTIVE, SeatCancelReason.VIEWER_REQUEST],
  );
  if (ledger === undefined) throw new Error(`no date ${dateId}`);
  expect(ledger.available + ledger.pooled + ledger.held + ledger.sold).toBe(ledger.capacity);
  expect(ledger.seats - ledger.back_on_sale).toBe(ledger.sold);

  for (const order of (await ordersOf(dataSource, dateId)).values()) {
    const owed = order.refunds.reduce((sum, { amount_minor }) => sum + Number(amount_minor), 0);
    expect(owed, order.id).toBeLessThanOrEqual(Number(order.total_minor));
  }
  const made = await dataSource.query<{ idempotency_key: string; amount_minor: string }[]>(
    `SELECT refund.idempotency_key, refund.amount_minor FROM order_refund AS refund
       JOIN seat_order AS placed ON placed.id = refund.order_id
      WHERE placed.date_id = $1 AND refund.refunded_at IS NOT NULL`,
    [dateId],
  );
  for (const { idempotency_key, amount_minor } of made) {
    expect(fake.refundedUnder(idempotency_key)?.amountMinor, idempotency_key).toBe(
      Number(amount_minor),
    );
    expect(
      fake.calls.filter((call) => call === `refund ${idempotency_key}`),
      idempotency_key,
    ).toHaveLength(1);
  }
}
