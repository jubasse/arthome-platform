import { updateReturning } from '@arthome-platform/transactions';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Queue, type Job } from 'bullmq';
import { DataSource, type EntityManager } from 'typeorm';

import { type Clock, intentCancelIdempotencyKey } from '@arthome/core';

import {
  FAIL_FAST_CONNECTION,
  INTENT_CANCELLATION_JOB,
  PRODUCER_TIMEOUT_MS,
  PROVIDER_CALL_SCHEDULES,
  REFUND_JOB,
  jobIdOf,
  staleAfterMs,
  type IntentCancellationJob,
  type ProviderCallSchedules,
  type RefundJob,
} from './provider-call-queues.js';
import { CLOCK } from '../clock.js';
import { SweeperLoop } from '../sweeper-loop.js';

const RELAY_EVERY_MS = 1_000;
export const RELAY_BATCH = 500;

/**
 * A queue as registered, its options and name, on the fail-fast connection: with Redis down a pass
 *   fails within the timeout and releases its row locks (`nestjs-event-driven` rule 2). The workers
 *   keep the shared connection, which waits for Redis to come back.
 */
export function failFastTwinOf<T>(registered: Queue<T>, logger: Logger): Queue<T> {
  const { connection } = registered.opts;
  if (!('url' in connection) || typeof connection.url !== 'string') {
    throw new Error(`queue ${registered.name}: BullModule.forRoot gives the connection by url`);
  }
  const twin = new Queue<T>(registered.name, {
    ...registered.opts,
    connection: { url: connection.url, ...FAIL_FAST_CONNECTION },
  });
  twin.on('error', (error) => {
    logger.warn(`${registered.name} producer: ${error.message}`);
  });
  return twin;
}

export class ProviderCallProducer implements OnApplicationShutdown {
  public constructor(
    public readonly refunds: Queue<RefundJob>,
    public readonly intentCancellations: Queue<IntentCancellationJob>,
  ) {}

  /** Before any row is locked: a connection Redis never answered fails here, not in the claim. */
  public async ready(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Redis not ready within ${String(PRODUCER_TIMEOUT_MS)} ms`));
      }, PRODUCER_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        Promise.all([this.refunds.waitUntilReady(), this.intentCancellations.waitUntilReady()]),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  public async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.refunds.close(), this.intentCancellations.close()]);
  }
}

/** Due: owed, neither made nor given up on, never enqueued. */
export const DUE_REFUNDS_SQL = `
  SELECT id, idempotency_key FROM order_refund
   WHERE refunded_at IS NULL AND dead_at IS NULL AND enqueued_at IS NULL
   ORDER BY owed_at
   LIMIT $1
     FOR UPDATE SKIP LOCKED`;

/** Asked again by a refund webhook, whatever became of the refund since. */
export const RERUN_ASKED_REFUNDS_SQL = `
  SELECT id, idempotency_key, refunded_at IS NULL AND dead_at IS NULL AS owed FROM order_refund
   WHERE rerun_asked_at IS NOT NULL
   ORDER BY rerun_asked_at
   LIMIT $1
     FOR UPDATE SKIP LOCKED`;

/** Lost: enqueued before `$1` and still unsettled, given up at `$2`. */
export const LOST_REFUNDS_SQL = `
  UPDATE order_refund SET dead_at = $2
   WHERE id IN (SELECT id FROM order_refund
                 WHERE refunded_at IS NULL AND dead_at IS NULL AND enqueued_at < $1
                 ORDER BY enqueued_at
                 LIMIT $3
                   FOR UPDATE SKIP LOCKED)
  RETURNING id`;

/** Due: owed, neither made nor given up on, and never enqueued or enqueued before `$1`. */
export const DUE_INTENT_CANCELLATIONS_SQL = `
  SELECT id FROM seat_order
   WHERE intent_cancel_owed_at IS NOT NULL AND intent_cancel_dead_at IS NULL
     AND (intent_cancel_enqueued_at IS NULL OR intent_cancel_enqueued_at < $1)
   ORDER BY intent_cancel_enqueued_at NULLS FIRST, intent_cancel_owed_at
   LIMIT $2
     FOR UPDATE SKIP LOCKED`;

/**
 * The outbox relay of the provider calls (HANDOVER §0m): every second, per kind, one transaction
 *   claims the rows due `FOR UPDATE SKIP LOCKED`, adds their jobs, stamps `enqueued_at`, commits;
 *   then the refund calls a webhook asked again run now (§0o).
 *   BullMQ ignores an id it already holds, so racing relays, or a crash between the add and the
 *   commit, enqueue once. It locks refund rows alone, or orders alone, and waits on nothing.
 */
@Injectable()
export class OwedCallRelay extends SweeperLoop {
  protected readonly logger = new Logger(OwedCallRelay.name);

  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly producer: ProviderCallProducer,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PROVIDER_CALL_SCHEDULES) private readonly schedules: ProviderCallSchedules,
  ) {
    super(RELAY_EVERY_MS, RELAY_BATCH);
  }

  /** One pass, the largest of the batches it settled. */
  public async relayDue(): Promise<number> {
    const lost = await this.giveUpLostRefunds();
    await this.producer.ready();
    const refunds = await this.relayRefunds();
    const reruns = await this.rerunAskedRefunds();
    const cancellations = await this.relayIntentCancellations();
    return Math.max(lost, refunds, reruns, cancellations);
  }

  /**
   * A refund enqueued longer ago than its whole schedule and still unsettled: its job was lost by
   *   Redis, or failed with its dead mark unwritten. Enqueued again, it would be asked past the
   *   provider's key retention (`REFUND_RETRIES_WITHIN_MS`), so it is given up instead, for an
   *   operator to replay once looked up at the provider (§0k). A cancellation is enqueued again.
   */
  private async giveUpLostRefunds(): Promise<number> {
    const nowMs = this.clock.nowMs();
    const lost = await updateReturning<{ id: string }>(this.dataSource, LOST_REFUNDS_SQL, [
      new Date(nowMs - staleAfterMs(this.schedules.refunds)),
      new Date(nowMs),
      RELAY_BATCH,
    ]);
    for (const { id } of lost) {
      this.logger.error(
        `refund ${id} given up, its job lost: the buyer's money is held without a seat ` +
          'until an operator replays the refund (apps/ticketing/HANDOVER.md §0k)',
      );
    }
    return lost.length;
  }

  protected pass(): Promise<number> {
    return this.relayDue();
  }

  private relayRefunds(): Promise<number> {
    const nowMs = this.clock.nowMs();
    return this.dataSource.transaction(async (manager) => {
      const due = await manager.query<{ id: string; idempotency_key: string }[]>(DUE_REFUNDS_SQL, [
        RELAY_BATCH,
      ]);
      if (due.length === 0) return 0;
      await this.producer.refunds.addBulk(
        due.map(({ id, idempotency_key }) => ({
          name: REFUND_JOB,
          data: { refundId: id },
          opts: { jobId: jobIdOf(idempotency_key) },
        })),
      );
      return stamp(manager, 'order_refund', 'enqueued_at', due, nowMs);
    });
  }

  /**
   * A refund webhook asked these calls again (R15, replaced): a job waiting its backoff runs now. One
   *   running keeps the request for the next pass, in case it fails into its backoff. Any other is
   *   settled, or queued to run soon, or lost to the sweep above, never added again here: a call
   *   asked past the provider's key retention may be made twice.
   */
  private rerunAskedRefunds(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const asked = await manager.query<{ id: string; idempotency_key: string; owed: boolean }[]>(
        RERUN_ASKED_REFUNDS_SQL,
        [RELAY_BATCH],
      );
      const answered: { id: string }[] = [];
      for (const { id, idempotency_key, owed } of asked) {
        const job = owed ? await this.producer.refunds.getJob(jobIdOf(idempotency_key)) : undefined;
        if (job !== undefined && (await job.isActive())) continue;
        if (job !== undefined && (await job.isDelayed())) await promoteUnlessMoved(job);
        answered.push({ id });
      }
      if (answered.length === 0) return 0;
      await manager.query(
        'UPDATE order_refund SET rerun_asked_at = NULL WHERE id = ANY($1::uuid[])',
        [answered.map(({ id }) => id)],
      );
      return answered.length;
    });
  }

  private relayIntentCancellations(): Promise<number> {
    const nowMs = this.clock.nowMs();
    return this.dataSource.transaction(async (manager) => {
      const due = await manager.query<{ id: string }[]>(DUE_INTENT_CANCELLATIONS_SQL, [
        new Date(nowMs - staleAfterMs(this.schedules.intentCancellations)),
        RELAY_BATCH,
      ]);
      if (due.length === 0) return 0;
      await this.producer.intentCancellations.addBulk(
        due.map(({ id }) => ({
          name: INTENT_CANCELLATION_JOB,
          data: { orderId: id },
          opts: { jobId: jobIdOf(intentCancelIdempotencyKey(id)) },
        })),
      );
      return stamp(manager, 'seat_order', 'intent_cancel_enqueued_at', due, nowMs);
    });
  }
}

/** A job leaving its delay on its own between the read and the promotion runs now anyway. */
async function promoteUnlessMoved(job: Job): Promise<void> {
  try {
    await job.promote();
  } catch (error) {
    if (await job.isDelayed()) throw error;
  }
}

async function stamp(
  manager: EntityManager,
  table: 'order_refund' | 'seat_order',
  column: 'enqueued_at' | 'intent_cancel_enqueued_at',
  rows: readonly { readonly id: string }[],
  nowMs: number,
): Promise<number> {
  await manager.query(`UPDATE ${table} SET ${column} = $2 WHERE id = ANY($1::uuid[])`, [
    rows.map(({ id }) => id),
    new Date(nowMs),
  ]);
  return rows.length;
}
