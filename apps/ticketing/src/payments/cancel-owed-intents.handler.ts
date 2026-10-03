import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { type Clock, type PaymentPort } from '@arthome/core';

import { CancelOwedIntents } from './cancel-owed-intents.command.js';
import {
  OWED_INTENT_CANCELLATION,
  attemptsMaxOf,
  claimOwedCalls,
  giveUpOwedCall,
} from './owed-calls.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactions } from '../ticketing-transactions.js';
import { PAYMENT_PORT } from './payment-tokens.js';

/**
 * adr-ticketing.md §6's cancellation of the intent of an order that failed, recorded by the
 *   sweeper, each attempt claimed and asked outside any transaction under `cancel:{orderId}`. Best
 *   effort: it narrows a late payment's window and cannot close it (§7).
 */
@CommandHandler(CancelOwedIntents)
export class CancelOwedIntentsHandler implements ICommandHandler<CancelOwedIntents> {
  private readonly logger = new Logger(CancelOwedIntentsHandler.name);

  public constructor(
    private readonly transactions: TicketingTransactions,
    @Inject(PAYMENT_PORT) private readonly payments: PaymentPort,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async execute({ batch }: CancelOwedIntents): Promise<number> {
    const claimed = await claimOwedCalls(
      this.dataSource,
      OWED_INTENT_CANCELLATION,
      { condition: 'payment_intent_ref IS NOT NULL', parameters: [] },
      batch,
      this.clock.nowMs(),
    );
    let cancelled = 0;
    for (const { id, attempts } of claimed) {
      const [owed] = await this.dataSource.query<{ payment_intent_ref: string }[]>(
        'SELECT payment_intent_ref FROM seat_order WHERE id = $1',
        [id],
      );
      if (owed === undefined) continue;
      try {
        await this.payments.cancelIntent(owed.payment_intent_ref, `cancel:${id}`);
      } catch (error) {
        await this.failed(id, attempts, error);
        continue;
      }
      await this.transactions.run(async ({ orders }) => {
        const order = await orders.findById(id);
        if (order === null) return;
        order.intentCancelled();
        await orders.save(order);
      });
      cancelled += 1;
    }
    return cancelled;
  }

  private async failed(orderId: string, attempts: number, error: unknown): Promise<void> {
    const stack = error instanceof Error ? error.stack : String(error);
    const attemptsMax = attemptsMaxOf(OWED_INTENT_CANCELLATION);
    if (attempts < attemptsMax) {
      this.logger.warn(
        `intent of order ${orderId} not cancelled, attempt ${String(attempts)} of ${String(attemptsMax)}`,
        stack,
      );
      return;
    }
    await giveUpOwedCall(this.dataSource, OWED_INTENT_CANCELLATION, orderId, this.clock.nowMs());
    this.logger.error(
      `intent of order ${orderId} given up after ${String(attempts)} attempts`,
      stack,
    );
  }
}
