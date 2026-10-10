import type { DataSource, EntityManager } from 'typeorm';

import { OrderState, money, type Instant, type Money } from '@arthome/core';

/**
 * The trace a refund was owed under, for the `order.refunded` the worker writes later: in the
 *   owing transaction, after the order's save inserted the refund's row.
 */
export async function recordRefundTraceparent(
  manager: EntityManager,
  refundId: string,
  traceparent: string | null,
): Promise<void> {
  const [, recorded] = await manager.query<[unknown[], number]>(
    'UPDATE order_refund SET traceparent = $2 WHERE id = $1',
    [refundId, traceparent],
  );
  if (recorded !== 1) {
    throw new Error(`refund ${refundId} has no row yet: save its order before recording its trace`);
  }
}

/** What the refund processor needs to ask the provider, and whether it still has to. */
export interface RefundCall {
  readonly orderId: string;
  readonly intentRef: string | null;
  readonly amount: Money;
  readonly idempotencyKey: string;
  readonly settled: boolean;
  readonly disputed: boolean;
  readonly traceparent: string | null;
}

/** Null for a refund this service holds no row for. */
export async function refundCallOf(
  dataSource: DataSource,
  refundId: string,
): Promise<RefundCall | null> {
  const [row] = await dataSource.query<
    {
      order_id: string;
      payment_intent_ref: string | null;
      amount_minor: string;
      currency_code: string;
      idempotency_key: string;
      settled: boolean;
      disputed: boolean;
      traceparent: string | null;
    }[]
  >(
    `SELECT refund.order_id, placed.payment_intent_ref, refund.amount_minor, refund.currency_code,
            refund.idempotency_key, refund.traceparent,
            refund.refunded_at IS NOT NULL OR refund.dead_at IS NOT NULL AS settled,
            placed.state = $2 AS disputed
       FROM order_refund AS refund
       JOIN seat_order AS placed ON placed.id = refund.order_id
      WHERE refund.id = $1`,
    [refundId, OrderState.DISPUTED],
  );
  if (row === undefined) return null;
  return {
    orderId: row.order_id,
    intentRef: row.payment_intent_ref,
    amount: money(Number(row.amount_minor), row.currency_code),
    idempotencyKey: row.idempotency_key,
    settled: row.settled,
    disputed: row.disputed,
    traceparent: row.traceparent,
  };
}

/**
 * A refund webhook's request (R15, replaced), in its transaction: the relay re-runs each call now,
 *   its backoff cleared. Only a refund still owed, neither made nor given up on.
 */
export async function askRefundCallsAgain(
  manager: EntityManager,
  refundIds: readonly string[],
  now: Instant,
): Promise<void> {
  if (refundIds.length === 0) return;
  await manager.query(
    `UPDATE order_refund SET rerun_asked_at = $2
      WHERE id = ANY($1::uuid[]) AND refunded_at IS NULL AND dead_at IS NULL
        AND rerun_asked_at IS NULL`,
    [refundIds, new Date(now)],
  );
}

/**
 * What the operator does with a refund given up on (§0k): replay it, unless its order is disputed.
 *   The dispute holds the buyer's money, and gives it back if the buyer wins it: replayed then, the
 *   refund would pay the buyer twice.
 */
export function operatorStepAfterGivingUp(disputed: boolean): string {
  return disputed
    ? "the dispute holds the buyer's money: do not replay the refund while the dispute is open, " +
        'nor once the buyer won it (apps/ticketing/HANDOVER.md §0k)'
    : "the buyer's money is held without a seat until an operator replays the refund " +
        '(apps/ticketing/HANDOVER.md §0k)';
}

/** After the last attempt failed: kept, owed, and never asked again until replayed (§0k). */
export async function giveUpRefund(
  dataSource: DataSource,
  refundId: string,
  now: Date,
): Promise<void> {
  await dataSource.query(
    'UPDATE order_refund SET dead_at = $2 WHERE id = $1 AND refunded_at IS NULL',
    [refundId, now],
  );
}
