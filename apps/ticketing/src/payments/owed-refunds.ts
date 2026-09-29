import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { Clock } from '@arthome/core';

import { OWED_REFUND, attemptsMaxOf, claimOwedCalls, giveUpOwedCall } from './owed-calls.js';
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
 * The money an order owes back (D-082), asked of the provider outside any transaction, and the
 *   order `refunded` in one after it, with `order.refunded` under the trace the debt was found in.
 *   The debt is on the order before any call, so a crash or an outage leaves it owed.
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

  /**
   * At once, right after the transaction that found the debt: a first try the attempts do not
   *   count, since a failure leaves the refund due to the worker's claimed ones. False when the
   *   order owes nothing; throws when the provider refuses or does not answer.
   */
  public async refund(orderId: string): Promise<boolean> {
    const owed = await this.transactions.run(async ({ manager, orders }) => {
      const order = await orders.findById(orderId);
      if (order?.owesRefund !== true || order.snapshot.intent === null) return null;
      const [trace] = await manager.query<{ refund_traceparent: string | null }[]>(
        'SELECT refund_traceparent FROM seat_order WHERE id = $1',
        [orderId],
      );
      return { order: order.snapshot, traceparent: trace?.refund_traceparent ?? null };
    });
    if (owed?.order.intent == null) return false;
    const { refundRef } = await this.payments.refund({
      intentRef: owed.order.intent.ref,
      amount: owed.order.quote.total,
      idempotencyKey: refundKeyOf(orderId),
    });
    await this.transactions.run(async ({ manager, orders }) => {
      const order = await orders.findById(orderId);
      if (order === null) return;
      order.markRefunded(refundRef, this.clock.now());
      await orders.save(order);
      await writeSeatOrderIntegrationEvents(manager, order.getUncommittedEvents(), {
        traceparent: owed.traceparent,
      });
    });
    return true;
  }

  /** The refunds due, each attempt claimed; answers how many were made. */
  public async refundDue(batch: number): Promise<number> {
    const claimed = await claimOwedCalls(
      this.dataSource,
      OWED_REFUND,
      { condition: 'state <> $1', parameters: [OrderState.REFUNDED] },
      batch,
      this.clock.nowMs(),
    );
    let made = 0;
    for (const { id, attempts } of claimed) {
      try {
        if (await this.refund(id)) made += 1;
      } catch (error) {
        await this.failed(id, attempts, error);
      }
    }
    return made;
  }

  private async failed(orderId: string, attempts: number, error: unknown): Promise<void> {
    const stack = error instanceof Error ? error.stack : String(error);
    const attemptsMax = attemptsMaxOf(OWED_REFUND);
    if (attempts < attemptsMax) {
      this.logger.warn(
        `refund owed by order ${orderId} not made, attempt ${String(attempts)} of ${String(attemptsMax)}`,
        stack,
      );
      return;
    }
    await giveUpOwedCall(this.dataSource, OWED_REFUND, orderId, this.clock.nowMs());
    this.logger.error(
      `refund owed by order ${orderId} given up after ${String(attempts)} attempts over a day: ` +
        "the buyer's money is held without a seat until an operator replays the refund " +
        '(apps/ticketing/HANDOVER.md §0k)',
      stack,
    );
  }
}
