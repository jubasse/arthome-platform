import { boundedCheck, type CheckResult } from '@arthome-platform/messaging';
import { Queue } from 'bullmq';
import type { DataSource } from 'typeorm';

import { MINUTE_MS, OrderState, SystemClock, type Clock } from '@arthome/core';

import {
  FAIL_FAST_CONNECTION,
  INTENT_CANCELLATION_QUEUE,
  PROVIDER_CALL_QUEUE_PREFIX,
  REFUND_QUEUE,
} from './provider-call-queues.js';

/** HANDOVER §0k's replays: the relay enqueues the row again within a second, under its key. */
export const REFUND_REPLAY =
  'UPDATE order_refund SET dead_at = NULL, enqueued_at = NULL WHERE id = $1 AND dead_at IS NOT NULL';
export const INTENT_CANCELLATION_REPLAY =
  'UPDATE seat_order SET intent_cancel_dead_at = NULL, intent_cancel_enqueued_at = NULL ' +
  'WHERE id = $1 AND intent_cancel_dead_at IS NOT NULL';

/**
 * The calls given up on: a refund given up is a buyer's money held without a seat. One on a
 *   disputed order is not: the dispute holds that money and gives it back if the buyer wins, so it
 *   is counted apart, never replayed (HANDOVER §0k), and turns nothing degraded.
 */
export function checkProviderCallsDead(dataSource: DataSource): Promise<CheckResult> {
  return boundedCheck('provider_calls_dead', 'degraded', async () => {
    const [dead] = await dataSource.query<
      { refunds: number; refunds_held_by_disputes: number; intent_cancellations: number }[]
    >(
      `SELECT count(*) FILTER (WHERE placed.state <> $1)::int AS refunds,
              count(*) FILTER (WHERE placed.state = $1)::int AS refunds_held_by_disputes,
              (SELECT count(*)::int FROM seat_order
                WHERE intent_cancel_dead_at IS NOT NULL
                  AND intent_cancel_owed_at IS NOT NULL) AS intent_cancellations
         FROM order_refund AS refund
         JOIN seat_order AS placed ON placed.id = refund.order_id
        WHERE refund.dead_at IS NOT NULL AND refund.refunded_at IS NULL`,
      [OrderState.DISPUTED],
    );
    const refunds = dead?.refunds ?? 0;
    const intentCancellations = dead?.intent_cancellations ?? 0;
    return {
      status: refunds + intentCancellations > 0 ? 'degraded' : 'up',
      detail: {
        refunds,
        refundsHeldByDisputes: dead?.refunds_held_by_disputes ?? 0,
        intentCancellations,
        refundReplay: REFUND_REPLAY,
        intentCancellationReplay: INTENT_CANCELLATION_REPLAY,
      },
    };
  });
}

/**
 * The relay enqueues a call owed within its next second: one owed a minute and never enqueued
 *   means no relay is running, or none can reach Redis (the worker down, crash-looping, or its
 *   producer's connection broken).
 */
export const PROVIDER_CALL_ENQUEUE_BOUND_MS = MINUTE_MS;

/** The calls owed longer than the bound and never enqueued: the worker is not doing its job. */
export function checkProviderCallsWaiting(
  dataSource: DataSource,
  clock: Clock = new SystemClock(),
): Promise<CheckResult> {
  return boundedCheck('provider_calls_waiting', 'degraded', async () => {
    const [waiting] = await dataSource.query<{ refunds: number; intent_cancellations: number }[]>(
      `SELECT (SELECT count(*)::int FROM order_refund
                WHERE refunded_at IS NULL AND dead_at IS NULL
                  AND enqueued_at IS NULL AND owed_at < $1) AS refunds,
              (SELECT count(*)::int FROM seat_order
                WHERE intent_cancel_owed_at IS NOT NULL AND intent_cancel_dead_at IS NULL
                  AND intent_cancel_enqueued_at IS NULL
                  AND intent_cancel_owed_at < $1) AS intent_cancellations`,
      [new Date(clock.nowMs() - PROVIDER_CALL_ENQUEUE_BOUND_MS)],
    );
    const refunds = waiting?.refunds ?? 0;
    const intentCancellations = waiting?.intent_cancellations ?? 0;
    return {
      status: refunds + intentCancellations > 0 ? 'degraded' : 'up',
      detail: {
        refunds,
        intentCancellations,
        boundSeconds: PROVIDER_CALL_ENQUEUE_BOUND_MS / 1_000,
      },
    };
  });
}

/** Redis answering the worker's queues, and what waits in them. */
export function checkProviderCallQueues(redisUrl: string): Promise<CheckResult> {
  return boundedCheck('provider_call_queues', 'degraded', async () => {
    const queues = [REFUND_QUEUE, INTENT_CANCELLATION_QUEUE].map(
      (name) =>
        new Queue(name, {
          prefix: PROVIDER_CALL_QUEUE_PREFIX,
          connection: { url: redisUrl, ...FAIL_FAST_CONNECTION },
        }),
    );
    try {
      const detail: Record<string, string | number> = {};
      for (const queue of queues) {
        const { status } = await queue.getBackend().client;
        if (status !== 'ready') return { status: 'degraded', detail: { [queue.name]: status } };
        const [waiting, delayed, active] = await Promise.all([
          queue.getWaitingCount(),
          queue.getDelayedCount(),
          queue.getActiveCount(),
        ]);
        detail[`${queue.name}.waiting`] = waiting;
        detail[`${queue.name}.delayed`] = delayed;
        detail[`${queue.name}.active`] = active;
      }
      return { status: 'up', detail };
    } finally {
      await Promise.all(queues.map((queue) => queue.close()));
    }
  });
}
