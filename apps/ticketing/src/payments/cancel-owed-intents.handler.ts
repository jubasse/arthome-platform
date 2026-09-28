import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { plusSeconds, type Clock } from '@arthome/core';

import { CancelOwedIntents } from './cancel-owed-intents.command.js';
import { PaymentPort } from './payment.port.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/** How long a cancellation the provider did not take waits before it is asked again. */
const CANCEL_RETRY_SECONDS = 30;

/**
 * adr-ticketing.md §6's cancellation of the intent of an order that failed, recorded by the
 *   sweeper and asked here, outside any transaction, under `cancel:{orderId}`. Best effort: it
 *   narrows the window of a late payment and cannot close it (§7).
 */
@CommandHandler(CancelOwedIntents)
export class CancelOwedIntentsHandler implements ICommandHandler<CancelOwedIntents> {
  private readonly logger = new Logger(CancelOwedIntentsHandler.name);

  public constructor(
    private readonly transactions: TicketingTransactions,
    private readonly payments: PaymentPort,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async execute({ batch }: CancelOwedIntents): Promise<number> {
    const now = this.clock.now();
    const due = await this.dataSource.query<{ id: string; payment_intent_ref: string }[]>(
      `SELECT id, payment_intent_ref FROM seat_order
        WHERE intent_cancel_owed_at <= $1 AND payment_intent_ref IS NOT NULL
        ORDER BY intent_cancel_owed_at
        LIMIT $2`,
      [new Date(now), batch],
    );
    for (const { id, payment_intent_ref: intentRef } of due) {
      try {
        await this.payments.cancelIntent(intentRef, `cancel:${id}`);
      } catch (error) {
        this.logger.warn(
          `intent of order ${id} not cancelled, asked again in ${String(CANCEL_RETRY_SECONDS)} s`,
          error instanceof Error ? error.stack : String(error),
        );
        await this.dataSource.query(
          'UPDATE seat_order SET intent_cancel_owed_at = $2 WHERE id = $1',
          [id, new Date(plusSeconds(now, CANCEL_RETRY_SECONDS))],
        );
        continue;
      }
      await this.transactions.run(async ({ orders }) => {
        const order = await orders.findById(id);
        if (order === null) return;
        order.intentCancelled();
        await orders.save(order);
      });
    }
    return due.length;
  }
}
