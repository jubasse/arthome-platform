/**
 * Two reject mechanisms, never conflated (events.md §1.4): Kafka Connect's own
 *   dead-letter queue takes CONNECTOR failures, this takes CONSUMER ones. One
 *   topic for both loses the distinction — pipeline broken versus message broken.
 */

/**
 * Throwing this DISCARDS the message: dead-letter queue, no replay. Anything
 *   unrecognised is transient instead — retrying a permanent failure costs three
 *   attempts, discarding a transient one loses the fact for good.
 */
export class PermanentError extends Error {
  override readonly name = 'PermanentError';
}

/** events.md §1.4 — 5 s absorbs a restart, 30 s a failover, 5 min a dependency that is down. */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 300_000];

/**
 * Without it, everything that failed together retries together: a dependency
 *   down ten seconds fails a thousand messages, and a fixed delay sends all
 *   thousand back at once, onto a dependency that has just come up.
 */
export const JITTER_RATIO = 0.2;

export type FailureRoute =
  | { readonly kind: 'retry'; readonly attempt: number; readonly notBefore: Date }
  | { readonly kind: 'dlq'; readonly reason: 'permanent' | 'exhausted' };

/**
 * From `firstMs`, doubled up to `capMs`, until they add up to `totalMs`: the schedule of a call that
 *   must outlast an incident.
 */
export function doublingDelays(firstMs: number, capMs: number, totalMs: number): number[] {
  const delays: number[] = [];
  for (let delay = firstMs, elapsed = 0; elapsed < totalMs; delay = Math.min(delay * 2, capMs)) {
    delays.push(delay);
    elapsed += delay;
  }
  return delays;
}

/** When the attempt after `attempts` failed ones is due; null once the last one has failed. */
export function nextAttemptAt(
  attempts: number,
  nowMs: number,
  delaysMs: readonly number[] = RETRY_DELAYS_MS,
  random: () => number = Math.random,
): Date | null {
  const delay = delaysMs[attempts - 1];
  if (delay === undefined) return null;
  return new Date(nowMs + delay + Math.floor(delay * JITTER_RATIO * random()));
}

/** One more than its delays: `nextAttemptAt` answers null after the last. */
export function attemptsAllowedBy(delaysMs: readonly number[]): number {
  return delaysMs.length + 1;
}

/** Pure so it is testable without a broker; `now` and `random` injected to pin the schedule. */
export function routeFailure(
  error: unknown,
  attemptsSoFar: number,
  now: Date,
  random: () => number = Math.random,
): FailureRoute {
  if (error instanceof PermanentError) return { kind: 'dlq', reason: 'permanent' };

  const attempt = attemptsSoFar + 1;
  const notBefore = nextAttemptAt(attempt, now.getTime(), RETRY_DELAYS_MS, random);
  if (notBefore === null) return { kind: 'dlq', reason: 'exhausted' };
  return { kind: 'retry', attempt, notBefore };
}

/**
 * Retry at ONE layer: a client retry, the broker's redelivery and this budget
 *   MULTIPLY — three of each is twenty-seven attempts, turning an outage into an
 *   overload. KafkaJS's own `retry` stays at its default, for connection faults.
 *
 * A retry topic reorders one key's events. `search-indexer` guards it with
 *   `version_type: external_gte`; `notifications` handles one type keyed by
 *   account and needs none. The next consumer applying two ordered events owes one.
 *
 * One topic of each per context, never shared. Alert on the dead-letter depth.
 */

export function retryTopic(service: string): string {
  return `arthome.${service}.retry`;
}

export function deadLetterTopic(service: string): string {
  return `arthome.${service}.dlq`;
}
