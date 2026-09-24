/**
 * What to do with a message a consumer could not apply.
 *
 * ⚠ TWO REJECT MECHANISMS EXIST AND THEY ARE NEVER CONFLATED (events.md §1.4).
 *   Kafka Connect's native dead-letter queue takes CONNECTOR failures — a
 *   payload the converter cannot read, a transform that throws. What is here
 *   takes CONSUMER failures — a business rule that refuses, a database that is
 *   not answering. Putting both in one topic loses the only useful distinction:
 *   one means the pipeline is broken, the other means a message is.
 */

/**
 * A failure that will fail again, identically, however many times it is retried:
 * a malformed payload, a schema violation, a final business rejection.
 *
 * ⚠ THROWING THIS IS A DECISION TO DISCARD. It sends the message straight to the
 *   dead-letter queue with no replay, so it is only correct when a retry cannot
 *   possibly change the outcome. Anything else — and anything unrecognised — is
 *   treated as transient, because retrying a permanent failure costs three
 *   attempts, while discarding a transient one loses the fact for good.
 */
export class PermanentError extends Error {
  override readonly name = 'PermanentError';
}

/**
 * The delays between attempts, from events.md §1.4.
 *
 * Three entries means three retries: 5 s absorbs a restart, 30 s a failover,
 * 5 min a dependency that is genuinely down. After that the message is not
 * going to succeed by waiting longer, and it goes to the dead-letter queue
 * where somebody can look at it.
 */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 300_000];

/**
 * The share of a delay that is randomised.
 *
 * ⚠ WITHOUT JITTER, EVERYTHING THAT FAILED TOGETHER RETRIES TOGETHER. A
 *   dependency that drops for ten seconds fails a thousand messages within
 *   milliseconds of each other, and a fixed 5 s delay sends all thousand back
 *   at the same instant — onto a dependency that has just come up. The outage
 *   repeats, now caused by the retry.
 */
export const JITTER_RATIO = 0.2;

export type FailureRoute =
  | { readonly kind: 'retry'; readonly attempt: number; readonly notBefore: Date }
  | { readonly kind: 'dlq'; readonly reason: 'permanent' | 'exhausted' };

/**
 * Decide where a failed message goes. Pure on purpose: the decision is the part
 * worth testing, and it must be testable without a broker.
 *
 * @param error - what the handler threw
 * @param attemptsSoFar - the `attempt` header's value, 0 on first delivery
 * @param now - injected so the schedule can be asserted
 * @param random - injected so the jitter can be pinned in a test
 */
export function routeFailure(
  error: unknown,
  attemptsSoFar: number,
  now: Date,
  random: () => number = Math.random,
): FailureRoute {
  if (error instanceof PermanentError) return { kind: 'dlq', reason: 'permanent' };

  const delay = RETRY_DELAYS_MS[attemptsSoFar];
  if (delay === undefined) return { kind: 'dlq', reason: 'exhausted' };

  const jitter = Math.floor(delay * JITTER_RATIO * random());

  return {
    kind: 'retry',
    attempt: attemptsSoFar + 1,
    notBefore: new Date(now.getTime() + delay + jitter),
  };
}

/**
 * ⚠ RETRY AT ONE LAYER ONLY. A client retry, the broker's own redelivery and
 *   this budget MULTIPLY: three of each is twenty-seven attempts for one
 *   message, and an outage becomes an overload caused by the retries. This
 *   module is the one owner for a consumer's business failures; KafkaJS's
 *   `retry` stays at its default for connection faults alone.
 *
 * ⚠ A RETRY TOPIC REORDERS ONE KEY'S EVENTS. Kafka's ordering holds per
 *   partition, and a message that goes away for five minutes comes back behind
 *   later events for the same aggregate. Nothing here guards that yet: the
 *   guard is an aggregate version on the consumer's side, and it is owed the
 *   day a consumer applies two events whose order matters.
 */

/** The retry topic of a consuming service. One per context, never shared. */
export function retryTopic(service: string): string {
  return `arthome.${service}.retry`;
}

/** The dead-letter topic of a consuming service. Alert on its depth. */
export function deadLetterTopic(service: string): string {
  return `arthome.${service}.dlq`;
}
