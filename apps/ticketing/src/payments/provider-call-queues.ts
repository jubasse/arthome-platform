import { JITTER_RATIO, attemptsAllowedBy, retryDelayAfter } from '@arthome-platform/messaging';
import type { Logger } from '@nestjs/common';
import type { DefaultJobOptions, Job, Worker, WorkerListener } from 'bullmq';

import { HOUR_MS } from '@arthome/core';

import { INTENT_CANCEL_RETRY_DELAYS_MS, REFUND_RETRY_DELAYS_MS } from './owed-calls.js';

/**
 * adr-ticketing.md §8: every call ticketing owes the payment provider, a BullMQ job in the worker
 *   process, rate-limited, retried on its schedule, then given up with a dead row (HANDOVER §0m).
 */
export const REFUND_QUEUE = 'ticketing-refunds';
export const INTENT_CANCELLATION_QUEUE = 'ticketing-intent-cancellations';

/** Braced: on a Redis Cluster a queue's keys share one hash slot (`nestjs-queues` rule 6). */
export const PROVIDER_CALL_QUEUE_PREFIX = '{ticketing}';

export const REFUND_JOB = 'refund.v1';
export const INTENT_CANCELLATION_JOB = 'intent-cancellation.v1';

/** Ids only: the row is read at each attempt, so a job never acts on what it was enqueued with. */
export interface RefundJob {
  readonly refundId: string;
}

export interface IntentCancellationJob {
  readonly orderId: string;
}

/**
 * Stripe's test-mode limit for the two together (25 a second), a quarter of its live one: a
 *   cancelled date's 10,000 refunds drain in about eight minutes.
 */
export const REFUND_RATE_LIMIT = { max: 20, duration: 1_000 } as const;
export const INTENT_CANCELLATION_RATE_LIMIT = { max: 5, duration: 1_000 } as const;
export const PROVIDER_CALL_CONCURRENCY = 5;

/**
 * How often a job may lose its worker mid-call and run again: under its key the provider makes the
 *   call once, so five reruns cover deploys or a node lost during an incident, and the bound stops a
 *   job that kills its worker from looping. BullMQ's default, one, failed the second in silence.
 */
export const PROVIDER_CALL_MAX_STALLED_COUNT = 5;

/** What a producer waits on Redis at most, for a command or for a connection never made. */
export const PRODUCER_TIMEOUT_MS = 2_000;

/** A producer's: no offline queue and one retry, so a Redis down fails a call at once. */
export const FAIL_FAST_CONNECTION = {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  commandTimeout: PRODUCER_TIMEOUT_MS,
} as const;

/** `cancel:{orderId}`, C1's `intentCancelIdempotencyKey` from PR C on, in the same format. */
export function intentCancelKeyOf(orderId: string): string {
  return `cancel:${orderId}`;
}

/**
 * The provider's key with its colons made dashes: BullMQ 6 refuses a custom job id holding a colon,
 *   unless it has exactly three segments, which it then files among its repeatable jobs. One key,
 *   one job id, both stable, so a job enqueued twice under it runs once.
 */
export function jobIdOf(idempotencyKey: string): string {
  return idempotencyKey.replaceAll(':', '-');
}

/** Each queue's retry delays, shortened by a suite that cannot wait a day. */
export interface ProviderCallSchedules {
  readonly refunds: readonly number[];
  readonly intentCancellations: readonly number[];
}

export const PROVIDER_CALL_SCHEDULES: unique symbol = Symbol('ProviderCallSchedules');

export const DEFAULT_PROVIDER_CALL_SCHEDULES: ProviderCallSchedules = {
  refunds: REFUND_RETRY_DELAYS_MS,
  intentCancellations: INTENT_CANCEL_RETRY_DELAYS_MS,
};

/** Not a BullMQ type: the worker's `backoffStrategy` answers it from the queue's schedule. */
export const PROVIDER_CALL_BACKOFF = 'provider-call-schedule';

/**
 * Nothing kept once settled (`nestjs-queues` rule 5): the row is the record and the dead letter,
 *   and a job kept would block its id when a replay enqueues it again.
 */
export function providerCallJobOptions(delaysMs: readonly number[]): DefaultJobOptions {
  return {
    attempts: attemptsAllowedBy(delaysMs),
    backoff: { type: PROVIDER_CALL_BACKOFF },
    removeOnComplete: true,
    removeOnFail: true,
  };
}

/**
 * When a row enqueued and still unsettled is enqueued again: past its whole schedule with the
 *   jitter, and an hour more, which only a Redis that lost the job leaves (refunds about 30.3 h,
 *   cancellations about 1.1 h).
 */
export function staleAfterMs(delaysMs: readonly number[]): number {
  const schedule = delaysMs.reduce((total, delay) => total + delay, 0);
  return Math.ceil(schedule * (1 + JITTER_RATIO)) + HOUR_MS;
}

export function isLastAttempt(job: Job): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

/** BullMQ's worker event for a failed job: a job's state, not an order's. */
export const JOB_FAILED: keyof WorkerListener = 'failed';

/**
 * Failed by BullMQ before any attempt ran, stalled past its bound: `process()` never sees it. The
 *   bound is the stalled check's, whichever worker runs it: every worker on a queue carries ours.
 */
export function stalledPastBound(job: Job): boolean {
  // Typed a string, absent unless BullMQ deferred the failure, which only a stall past its bound does.
  return (job.deferredFailure as string | undefined) !== undefined;
}

/**
 * `@Processor`'s options are static and the schedule is injected: the backoff is set on this
 *   instance's worker before it starts (`autorun: false`), so no job fails without it.
 */
export function runOnSchedule(worker: Worker, delaysMs: readonly number[], logger: Logger): void {
  // eslint-disable-next-line no-param-reassign -- the worker @nestjs/bullmq built takes its backoff here.
  worker.opts.settings = {
    ...worker.opts.settings,
    backoffStrategy: (attemptsMade: number) => retryDelayAfter(attemptsMade, delaysMs) ?? -1,
  };
  worker.run().catch((error: unknown) => {
    logger.error(
      `worker of ${worker.name} stopped`,
      error instanceof Error ? error.stack : String(error),
    );
  });
}
