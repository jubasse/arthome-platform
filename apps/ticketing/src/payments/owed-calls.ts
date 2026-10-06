import { JITTER_RATIO, RETRY_DELAYS_MS, doublingDelays } from '@arthome-platform/messaging';
import type { DataSource, EntityManager } from 'typeorm';

import { DAY_MS, HOUR_MS } from '@arthome/core';

/**
 * Stripe keeps an idempotency key 24 hours: a refund asked again past it, under the same key, may
 *   be made twice. So every automatic attempt lands an hour inside it, the jitter included; then
 *   the refund is given up, and an operator looks it up at the provider before replaying it (§0k).
 */
export const PROVIDER_KEY_RETENTION_MS = DAY_MS;
export const REFUND_RETRIES_WITHIN_MS = PROVIDER_KEY_RETENTION_MS - HOUR_MS;

/**
 * A refund owed is money held without a seat, so its attempts outlast a provider's incident: the
 *   delay doubles from the first up to the cap, and the doubling stops a cap short of the bound
 *   with each delay's jitter, so the last attempt lands under it.
 */
export const REFUND_FIRST_RETRY_DELAY_MS = 5_000;
export const REFUND_RETRY_DELAY_CAP_MS = HOUR_MS;

export const REFUND_RETRY_DELAYS_MS: readonly number[] = doublingDelays(
  REFUND_FIRST_RETRY_DELAY_MS,
  REFUND_RETRY_DELAY_CAP_MS,
  REFUND_RETRIES_WITHIN_MS / (1 + JITTER_RATIO) - REFUND_RETRY_DELAY_CAP_MS,
);

/** Best effort (adr-ticketing.md §6): the consumers' bound is enough. */
export const INTENT_CANCEL_RETRY_DELAYS_MS: readonly number[] = RETRY_DELAYS_MS;

/** What the intent-cancellation processor needs to ask the provider, and whether it still has to. */
export interface IntentCancellationCall {
  readonly intentRef: string | null;
  /** Owed, and neither made nor given up on: a payment clears it. */
  readonly owed: boolean;
}

/** Null for an order this service does not hold. */
export async function intentCancellationOf(
  dataSource: DataSource,
  orderId: string,
): Promise<IntentCancellationCall | null> {
  const [row] = await dataSource.query<{ payment_intent_ref: string | null; owed: boolean }[]>(
    `SELECT payment_intent_ref,
            intent_cancel_owed_at IS NOT NULL AND intent_cancel_dead_at IS NULL AS owed
       FROM seat_order WHERE id = $1`,
    [orderId],
  );
  return row === undefined ? null : { intentRef: row.payment_intent_ref, owed: row.owed };
}

/** After the last attempt failed: the fact kept, never asked again until replayed (§0k). */
export async function giveUpIntentCancellation(
  dataSource: DataSource,
  orderId: string,
  now: Date,
): Promise<void> {
  await dataSource.query(
    `UPDATE seat_order SET intent_cancel_dead_at = $2
      WHERE id = $1 AND intent_cancel_owed_at IS NOT NULL`,
    [orderId, now],
  );
}

/**
 * An intent owed a cancellation again: the relay enqueues it anew, a new job with its attempts
 *   anew once the last one ended, while a job still pending reads the mark at its next attempt.
 */
export async function oweIntentCancellationAgain(
  manager: EntityManager,
  orderId: string,
): Promise<void> {
  await manager.query(
    `UPDATE seat_order SET intent_cancel_enqueued_at = NULL, intent_cancel_dead_at = NULL
      WHERE id = $1`,
    [orderId],
  );
}
