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

import { type Clock, type PaymentPort } from '@arthome/core';

import { PAYMENT_PORT } from './payment-tokens.js';
import {
  PROVIDER_CALL_CONCURRENCY,
  PROVIDER_CALL_SCHEDULES,
  REFUND_JOB,
  REFUND_QUEUE,
  REFUND_RATE_LIMIT,
  isLastAttempt,
  runOnSchedule,
  type ProviderCallSchedules,
  type RefundJob,
} from './provider-call-queues.js';
import { giveUpRefund, refundCallOf } from './refund-ledger.js';
import { CLOCK } from '../clock.js';
import { writeSeatOrderIntegrationEvents } from '../orders/seat-order-integration-events.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/**
 * A refund owed, asked of the provider outside any transaction under its key, then made in one:
 *   the order under its lock, its refund row, `order.refunded` under the trace the refund was owed
 *   with. A stalled job runs again under the same key, so the provider refunds once.
 */
@Processor(REFUND_QUEUE, {
  concurrency: PROVIDER_CALL_CONCURRENCY,
  limiter: REFUND_RATE_LIMIT,
  autorun: false,
})
export class RefundProcessor
  extends WorkerHost
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(RefundProcessor.name);

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
    runOnSchedule(this.worker, this.schedules.refunds, this.logger);
  }

  /** Before the pool closes: a job in flight finishes its transaction (`nestjs-queues` rule 7). */
  public beforeApplicationShutdown(): Promise<void> {
    return this.worker.close();
  }

  public async process(job: Job<RefundJob>): Promise<void> {
    if (job.name !== REFUND_JOB) throw new UnrecoverableError(`unknown job ${job.name}`);
    try {
      await this.refund(job.data.refundId);
    } catch (error) {
      await this.failed(job, error);
      throw error;
    }
  }

  @OnWorkerEvent('error')
  public onError(error: Error): void {
    this.logger.warn(`refund queue: ${error.message}`);
  }

  /** A refund made, given up on or unknown here settles the job without a call. */
  private async refund(refundId: string): Promise<void> {
    const call = await refundCallOf(this.dataSource, refundId);
    if (call === null || call.settled) return;
    if (call.intentRef === null) throw new Error(`order ${call.orderId} holds no intent to refund`);
    const { refundRef } = await this.payments.refund({
      intentRef: call.intentRef,
      amount: call.amount,
      idempotencyKey: call.idempotencyKey,
    });
    await this.transactions.run(async ({ manager, orders }) => {
      const order = await orders.findById(call.orderId);
      if (order === null) return;
      order.refundMade(refundId, refundRef, this.clock.now());
      await orders.save(order);
      await writeSeatOrderIntegrationEvents(manager, order.getUncommittedEvents(), {
        traceparent: call.traceparent,
      });
    });
  }

  private async failed(job: Job<RefundJob>, error: unknown): Promise<void> {
    const { refundId } = job.data;
    const stack = error instanceof Error ? error.stack : String(error);
    const attempt = `attempt ${String(job.attemptsMade + 1)} of ${String(job.opts.attempts ?? 1)}`;
    if (!isLastAttempt(job)) {
      this.logger.warn(`refund ${refundId} not made, ${attempt}`, stack);
      return;
    }
    await giveUpRefund(this.dataSource, refundId, new Date(this.clock.nowMs())).catch(
      (cause: unknown) => {
        this.logger.error(`refund ${refundId} not marked given up`, String(cause));
      },
    );
    this.logger.error(
      `refund ${refundId} given up after ${attempt}: the buyer's money is held without a seat ` +
        'until an operator replays the refund (apps/ticketing/HANDOVER.md §0k)',
      stack,
    );
  }
}
