import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Inject,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { DataSource } from 'typeorm';

import { type Clock, intentCancelIdempotencyKey, type PaymentPort } from '@arthome/core';

import { giveUpIntentCancellation, intentCancellationOf } from './owed-calls.js';
import { PAYMENT_PORT } from './payment-tokens.js';
import {
  INTENT_CANCELLATION_JOB,
  INTENT_CANCELLATION_QUEUE,
  INTENT_CANCELLATION_RATE_LIMIT,
  JOB_FAILED,
  PROVIDER_CALL_CONCURRENCY,
  PROVIDER_CALL_MAX_STALLED_COUNT,
  PROVIDER_CALL_SCHEDULES,
  isLastAttempt,
  runOnSchedule,
  stalledPastBound,
  type IntentCancellationJob,
  type ProviderCallSchedules,
} from './provider-call-queues.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/**
 * adr-ticketing.md §6's cancellation of the intent of an order that failed, asked under
 *   `cancel:{orderId}`. Best effort: it narrows a late payment's window and cannot close it (§7).
 *   The mark is read at each attempt, so a payment that cleared it ends the job without a call.
 */
@Processor(INTENT_CANCELLATION_QUEUE, {
  concurrency: PROVIDER_CALL_CONCURRENCY,
  limiter: INTENT_CANCELLATION_RATE_LIMIT,
  maxStalledCount: PROVIDER_CALL_MAX_STALLED_COUNT,
  autorun: false,
})
export class IntentCancellationProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(IntentCancellationProcessor.name);

  public constructor(
    private readonly transactions: TicketingTransactions,
    @Inject(PAYMENT_PORT) private readonly payments: PaymentPort,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PROVIDER_CALL_SCHEDULES) private readonly schedules: ProviderCallSchedules,
  ) {
    super();
  }

  public onApplicationBootstrap(): void {
    runOnSchedule(this.worker, this.schedules.intentCancellations, this.logger);
  }

  public beforeApplicationShutdown(): Promise<void> {
    return this.worker.close();
  }

  public async process(job: Job<IntentCancellationJob>): Promise<void> {
    if (job.name !== INTENT_CANCELLATION_JOB) {
      throw new UnrecoverableError(`unknown job ${job.name}`);
    }
    try {
      await this.cancel(job.data.orderId);
    } catch (error) {
      await this.failed(job, error);
      throw error;
    }
  }

  @OnWorkerEvent('error')
  public onError(error: Error): void {
    this.logger.warn(`intent-cancellation queue: ${error.message}`);
  }

  /** The one failure written from here: the others are marked in `process()`. */
  @OnWorkerEvent(JOB_FAILED)
  public async onFailed(job: Job<IntentCancellationJob> | undefined, error: Error): Promise<void> {
    if (job === undefined || !stalledPastBound(job)) return;
    await this.giveUp(job.data.orderId, `stalled ${String(job.stalledCounter)} times`, error.stack);
  }

  private async cancel(orderId: string): Promise<void> {
    const call = await intentCancellationOf(this.dataSource, orderId);
    if (call?.owed !== true || call.intentRef === null) return;
    await this.payments.cancelIntent(call.intentRef, intentCancelIdempotencyKey(orderId));
    await this.transactions.run(async ({ orders }) => {
      const order = await orders.findById(orderId);
      if (order === null) return;
      order.intentCancelled();
      await orders.save(order);
    });
  }

  private async failed(job: Job<IntentCancellationJob>, error: unknown): Promise<void> {
    const { orderId } = job.data;
    const stack = error instanceof Error ? error.stack : String(error);
    const attempt = `attempt ${String(job.attemptsMade + 1)} of ${String(job.opts.attempts ?? 1)}`;
    if (!isLastAttempt(job)) {
      this.logger.warn(`intent of order ${orderId} not cancelled, ${attempt}`, stack);
      return;
    }
    await this.giveUp(orderId, `after ${attempt}`, stack);
  }

  private async giveUp(orderId: string, why: string, stack: string | undefined): Promise<void> {
    await giveUpIntentCancellation(this.dataSource, orderId, new Date(this.clock.nowMs())).catch(
      (cause: unknown) => {
        this.logger.error(
          `intent cancellation of order ${orderId} not marked given up`,
          String(cause),
        );
      },
    );
    this.logger.error(`intent of order ${orderId} given up ${why}`, stack);
  }
}
