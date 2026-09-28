import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { Clock } from '@arthome/core';

import { PaymentPort } from './payment.port.js';
import { CLOCK } from '../clock.js';
import { OrderState } from '../orders/commerce-vocabulary.js';
import { writeSeatOrderIntegrationEvents } from '../orders/seat-order-integration-events.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/** adr-ticketing.md §8: a refund asked twice under one key is made once by the provider. */
export function refundKeyOf(orderId: string): string {
  return `refund:${orderId}`;
}

/**
 * The money an order owes back (D-082), refunded at once through the provider, outside any
 *   transaction, and the order `refunded` in one after it, with `order.refunded`. The debt is on
 *   the order before the call, so a crash or a provider outage leaves it owed, and the payment
 *   worker's next pass asks again under the same key.
 */
@Injectable()
export class OwedRefunds {
  private readonly logger = new Logger(OwedRefunds.name);

  public constructor(
    private readonly transactions: TicketingTransactions,
    private readonly payments: PaymentPort,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** False when the order owes nothing; throws when the provider does not answer. */
  public async refund(orderId: string): Promise<boolean> {
    const owed = await this.transactions.run(async ({ orders }) => {
      const order = await orders.findById(orderId);
      return order?.owesRefund === true ? order.snapshot : null;
    });
    if (owed?.intent == null) return false;
    const { refundRef } = await this.payments.refund({
      intentRef: owed.intent.ref,
      amount: owed.quote.total,
      idempotencyKey: refundKeyOf(orderId),
    });
    await this.transactions.run(async ({ manager, orders }) => {
      const order = await orders.findById(orderId);
      if (order === null) return;
      order.markRefunded(refundRef, this.clock.now());
      await orders.save(order);
      await writeSeatOrderIntegrationEvents(manager, order.getUncommittedEvents(), {
        traceparent: null,
      });
    });
    return true;
  }

  /** The refunds still owed, oldest first; one the provider refuses is left owed and logged. */
  public async refundDue(batch: number): Promise<number> {
    const due = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM seat_order
        WHERE refund_owed_at IS NOT NULL AND state <> $1
        ORDER BY refund_owed_at
        LIMIT $2`,
      [OrderState.REFUNDED, batch],
    );
    for (const { id } of due) {
      try {
        await this.refund(id);
      } catch (error) {
        this.logger.error(
          `refund owed by order ${id} not made, asked again next pass`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    return due.length;
  }
}
