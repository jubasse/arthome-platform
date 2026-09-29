import { JITTER_RATIO, RETRY_DELAYS_MS } from '@arthome-platform/messaging';
import type { DataSource } from 'typeorm';

/**
 * adr-ticketing.md §8's policy for every call the payment worker owes the provider: the consumers'
 *   delays, with their jitter, then given up. The attempts sit beside the fact they serve, so a
 *   queue can take over from them (T4).
 */
export const PROVIDER_ATTEMPTS_MAX = RETRY_DELAYS_MS.length + 1;

/** When the attempt after `attempts` failed ones is due; null once the last one has failed. */
export function nextAttemptAt(attempts: number, nowMs: number): Date | null {
  const delay = RETRY_DELAYS_MS[attempts - 1];
  if (delay === undefined) return null;
  return new Date(nowMs + delay + Math.floor(delay * JITTER_RATIO * Math.random()));
}

/** The four columns of one kind of owed call on `seat_order`. */
export interface OwedCallColumns {
  /** When the call became owed: the fact, never overwritten, cleared once the call is made. */
  readonly owed: string;
  readonly attempts: string;
  readonly nextAttemptAt: string;
  readonly deadAt: string;
}

export const OWED_REFUND: OwedCallColumns = {
  owed: 'refund_owed_at',
  attempts: 'refund_attempts',
  nextAttemptAt: 'refund_next_attempt_at',
  deadAt: 'refund_dead_at',
};

export const OWED_INTENT_CANCELLATION: OwedCallColumns = {
  owed: 'intent_cancel_owed_at',
  attempts: 'intent_cancel_attempts',
  nextAttemptAt: 'intent_cancel_next_attempt_at',
  deadAt: 'intent_cancel_dead_at',
};

export interface ClaimedCall {
  readonly id: string;
  /** This attempt's number, from 1. */
  readonly attempts: number;
}

/** The last attempt's lease: nobody else asks while it is in flight. */
const LAST_ATTEMPT_LEASE_MS = RETRY_DELAYS_MS.at(-1) ?? 0;

/**
 * Up to `batch` calls due, oldest owed first, claimed `FOR UPDATE SKIP LOCKED` in a transaction of
 *   their own that counts the attempt and moves the next one out by the backoff: another replica's
 *   pass skips them, and a crash during the call leaves them due again then, never lost. A call
 *   refused for good waits its delays like any other, so newer ones are not queued behind it.
 */
export function claimOwedCalls(
  dataSource: DataSource,
  columns: OwedCallColumns,
  due: { readonly condition: string; readonly parameters: readonly unknown[] },
  batch: number,
  nowMs: number,
): Promise<ClaimedCall[]> {
  const { owed, attempts, nextAttemptAt: next, deadAt } = columns;
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
            nextAttemptAt(attempt, nowMs) ?? new Date(nowMs + LAST_ATTEMPT_LEASE_MS),
        ),
      ],
    );
    return claimed;
  });
}

/** After the last attempt failed: kept, with its fact, and never asked again. */
export async function giveUpOwedCall(
  dataSource: DataSource,
  columns: OwedCallColumns,
  id: string,
  nowMs: number,
): Promise<void> {
  await dataSource.query(
    `UPDATE seat_order SET ${columns.deadAt} = $2, ${columns.nextAttemptAt} = NULL WHERE id = $1`,
    [id, new Date(nowMs)],
  );
}
