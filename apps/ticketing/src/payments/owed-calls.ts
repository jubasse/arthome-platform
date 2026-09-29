import { JITTER_RATIO, RETRY_DELAYS_MS } from '@arthome-platform/messaging';
import type { DataSource } from 'typeorm';

import { DAY_MS, HOUR_MS } from '@arthome/core';

/** From `firstMs`, doubled up to `capMs`, until they add up to `totalMs`. */
function doublingDelays(firstMs: number, capMs: number, totalMs: number): number[] {
  const delays: number[] = [];
  for (let delay = firstMs, elapsed = 0; elapsed < totalMs; delay = Math.min(delay * 2, capMs)) {
    delays.push(delay);
    elapsed += delay;
  }
  return delays;
}

/**
 * A refund owed is money held without a seat, so its attempts outlast a provider's incident: the
 *   delay doubles from the first up to the cap, until about a day has passed (up to a fifth more
 *   with the jitter). Idempotent under its key, the long tail costs nothing.
 */
export const REFUND_FIRST_RETRY_DELAY_MS = 5_000;
export const REFUND_RETRY_DELAY_CAP_MS = HOUR_MS;
export const REFUND_GIVE_UP_AFTER_MS = DAY_MS;

export const REFUND_RETRY_DELAYS_MS: readonly number[] = doublingDelays(
  REFUND_FIRST_RETRY_DELAY_MS,
  REFUND_RETRY_DELAY_CAP_MS,
  REFUND_GIVE_UP_AFTER_MS,
);

/** When the attempt after `attempts` failed ones is due; null once the last one has failed. */
export function nextAttemptAt(
  attempts: number,
  nowMs: number,
  delaysMs: readonly number[] = RETRY_DELAYS_MS,
): Date | null {
  const delay = delaysMs[attempts - 1];
  if (delay === undefined) return null;
  return new Date(nowMs + delay + Math.floor(delay * JITTER_RATIO * Math.random()));
}

/**
 * adr-ticketing.md §8: a kind of call the payment worker owes the provider, its attempts beside the
 *   fact they serve so a queue can take over from them (T4), and its delays, with jitter, before it
 *   is given up.
 */
export interface OwedCall {
  /** When the call became owed: the fact, never overwritten, cleared once the call is made. */
  readonly owed: string;
  readonly attempts: string;
  readonly nextAttemptAt: string;
  readonly deadAt: string;
  readonly retryDelaysMs: readonly number[];
}

export const OWED_REFUND: OwedCall = {
  owed: 'refund_owed_at',
  attempts: 'refund_attempts',
  nextAttemptAt: 'refund_next_attempt_at',
  deadAt: 'refund_dead_at',
  retryDelaysMs: REFUND_RETRY_DELAYS_MS,
};

/** Best effort (adr-ticketing.md §6): the consumers' bound is enough. */
export const OWED_INTENT_CANCELLATION: OwedCall = {
  owed: 'intent_cancel_owed_at',
  attempts: 'intent_cancel_attempts',
  nextAttemptAt: 'intent_cancel_next_attempt_at',
  deadAt: 'intent_cancel_dead_at',
  retryDelaysMs: RETRY_DELAYS_MS,
};

/** Its attempts before it is given up: one more than its delays. */
export function attemptsMaxOf({ retryDelaysMs }: OwedCall): number {
  return retryDelaysMs.length + 1;
}

export interface ClaimedCall {
  readonly id: string;
  /** This attempt's number, from 1. */
  readonly attempts: number;
}

/**
 * Up to `batch` calls due, oldest owed first, claimed `FOR UPDATE SKIP LOCKED` in a transaction of
 *   their own that counts the attempt and moves the next one out by the backoff: another replica's
 *   pass skips them, and a crash during the call leaves them due again then, never lost. A call
 *   refused for good waits its delays like any other, so newer ones are not queued behind it.
 */
export function claimOwedCalls(
  dataSource: DataSource,
  call: OwedCall,
  due: { readonly condition: string; readonly parameters: readonly unknown[] },
  batch: number,
  nowMs: number,
): Promise<ClaimedCall[]> {
  const { owed, attempts, nextAttemptAt: next, deadAt, retryDelaysMs } = call;
  // The last attempt's lease: nobody else asks while it is in flight.
  const lastAttemptLeaseMs = retryDelaysMs.at(-1) ?? 0;
  return dataSource.transaction(async (manager) => {
    const offset = due.parameters.length;
    const claimed = await manager.query<{ id: string; attempts: number }[]>(
      `SELECT id, ${attempts} + 1 AS attempts FROM seat_order
        WHERE ${owed} IS NOT NULL AND ${deadAt} IS NULL AND (${due.condition})
          AND (${next} IS NULL OR ${next} <= $${String(offset + 1)})
        ORDER BY ${next} ASC NULLS FIRST, ${owed}
        LIMIT $${String(offset + 2)}
          FOR UPDATE SKIP LOCKED`,
      [...due.parameters, new Date(nowMs), batch],
    );
    if (claimed.length === 0) return [];
    await manager.query(
      `UPDATE seat_order AS placed
          SET ${attempts} = claimed.attempts, ${next} = claimed.next
         FROM unnest($1::uuid[], $2::int[], $3::timestamptz[]) AS claimed(id, attempts, next)
        WHERE placed.id = claimed.id`,
      [
        claimed.map(({ id }) => id),
        claimed.map(({ attempts: attempt }) => attempt),
        claimed.map(
          ({ attempts: attempt }) =>
            nextAttemptAt(attempt, nowMs, retryDelaysMs) ?? new Date(nowMs + lastAttemptLeaseMs),
        ),
      ],
    );
    return claimed;
  });
}

/** After the last attempt failed: kept, with its fact, and never asked again. */
export async function giveUpOwedCall(
  dataSource: DataSource,
  call: OwedCall,
  id: string,
  nowMs: number,
): Promise<void> {
  await dataSource.query(
    `UPDATE seat_order SET ${call.deadAt} = $2, ${call.nextAttemptAt} = NULL WHERE id = $1`,
    [id, new Date(nowMs)],
  );
}
