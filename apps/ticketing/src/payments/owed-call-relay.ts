import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, type EntityManager } from 'typeorm';

import { type Clock } from '@arthome/core';

import {
  FAIL_FAST_CONNECTION,
  INTENT_CANCELLATION_JOB,
  PRODUCER_TIMEOUT_MS,
  PROVIDER_CALL_SCHEDULES,
  REFUND_JOB,
  intentCancelKeyOf,
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

/** Due: owed, neither made nor given up on, and never enqueued or enqueued before `$1`. */
export const DUE_REFUNDS_SQL = `
  SELECT id, idempotency_key FROM order_refund
   WHERE refunded_at IS NULL AND dead_at IS NULL
     AND (enqueued_at IS NULL OR enqueued_at < $1)
   ORDER BY enqueued_at NULLS FIRST, owed_at
   LIMIT $2
     FOR UPDATE SKIP LOCKED`;

export const DUE_INTENT_CANCELLATIONS_SQL = `
  SELECT id FROM seat_order
   WHERE intent_cancel_owed_at IS NOT NULL AND intent_cancel_dead_at IS NULL
     AND (intent_cancel_enqueued_at IS NULL OR intent_cancel_enqueued_at < $1)
   ORDER BY intent_cancel_enqueued_at NULLS FIRST, intent_cancel_owed_at
   LIMIT $2
     FOR UPDATE SKIP LOCKED`;

/**
 * The outbox relay of the provider calls (HANDOVER §0m): every second, per kind, one transaction
 *   claims the rows due `FOR UPDATE SKIP LOCKED`, adds their jobs, stamps `enqueued_at`, commits.
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

  /** One pass, the larger of the two batches it enqueued. */
  public async relayDue(): Promise<number> {
    await this.producer.ready();
    const refunds = await this.relayRefunds();
    const cancellations = await this.relayIntentCancellations();
    return Math.max(refunds, cancellations);
  }

  protected pass(): Promise<number> {
    return this.relayDue();
  }

  private relayRefunds(): Promise<number> {
    const nowMs = this.clock.nowMs();
    return this.dataSource.transaction(async (manager) => {
      const due = await manager.query<{ id: string; idempotency_key: string }[]>(DUE_REFUNDS_SQL, [
        new Date(nowMs - staleAfterMs(this.schedules.refunds)),
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
          opts: { jobId: jobIdOf(intentCancelKeyOf(id)) },
        })),
      );
      return stamp(manager, 'seat_order', 'intent_cancel_enqueued_at', due, nowMs);
    });
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
