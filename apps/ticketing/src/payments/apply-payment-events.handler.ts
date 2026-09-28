import { JITTER_RATIO, RETRY_DELAYS_MS } from '@arthome-platform/messaging';
import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { OrderErrorCode, type Clock, type Instant } from '@arthome/core';

import { ApplyPaymentEvents } from './apply-payment-events.command.js';
import { OwedRefunds } from './owed-refunds.js';
import { PaymentEventKind } from './payment.port.js';
import { CLOCK } from '../clock.js';
import { OrderState } from '../orders/commerce-vocabulary.js';
import { failUnpaidOrder } from '../orders/fail-unpaid-order.js';
import { writeSeatOrderIntegrationEvents } from '../orders/seat-order-integration-events.js';
import type { SeatOrder } from '../orders/seat-order.aggregate.js';
import { settleConfirmedPayment } from '../orders/settle-payment.js';
import { TicketingTransactions, type TicketingTransaction } from '../ticketing-transactions.js';

interface InboxRow {
  readonly event_id: string;
  readonly kind: PaymentEventKind;
  readonly intent_ref: string | null;
  readonly order_id: string | null;
  readonly decline_code: string | null;
  readonly traceparent: string | null;
}

/** An event that no retry can apply: no order is known for it. */
class Unappliable extends Error {}

/**
 * adr-ticketing.md §8's worker: each recorded webhook applied in a transaction of its own, the
 *   inbox row claimed `FOR UPDATE SKIP LOCKED`, then its order before its hold, and marked applied
 *   with the effect. A webhook records a fact and never decides (adr-payments.md §7.3): the order
 *   moves forward only, so a duplicate or a fact behind its state changes nothing. A failure is
 *   retried after the consumers' delays, then the row is given up on, kept with its bytes as its
 *   own dead letter and logged as an error (§7.4); one no order is known for, at once.
 */
@CommandHandler(ApplyPaymentEvents)
export class ApplyPaymentEventsHandler implements ICommandHandler<ApplyPaymentEvents> {
  private readonly logger = new Logger(ApplyPaymentEventsHandler.name);

  public constructor(
    private readonly transactions: TicketingTransactions,
    private readonly refunds: OwedRefunds,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async execute({ batch }: ApplyPaymentEvents): Promise<number> {
    const due = await this.dataSource.query<{ event_id: string }[]>(
      `SELECT event_id FROM stripe_event_inbox
        WHERE applied_at IS NULL AND dead_at IS NULL AND (retry_at IS NULL OR retry_at <= $1)
        ORDER BY received_at
        LIMIT $2`,
      [new Date(this.clock.now()), batch],
    );
    for (const { event_id } of due) {
      let orderId: string | null = null;
      try {
        orderId = await this.transactions.run((transaction) => this.applyIn(transaction, event_id));
      } catch (error) {
        await this.failed(event_id, error);
      }
      if (orderId !== null) await this.refundIfOwed(orderId);
    }
    return due.length;
  }

  /** The order the event moved, or null when another pass holds the row or already applied it. */
  private async applyIn(
    transaction: TicketingTransaction,
    eventId: string,
  ): Promise<string | null> {
    const { manager, orders } = transaction;
    const [row] = await manager.query<InboxRow[]>(
      `SELECT event_id, kind, intent_ref, order_id, decline_code, traceparent
         FROM stripe_event_inbox
        WHERE event_id = $1 AND applied_at IS NULL AND dead_at IS NULL
          FOR UPDATE SKIP LOCKED`,
      [eventId],
    );
    if (row === undefined) return null;
    const order = row.order_id === null ? null : await orders.findById(row.order_id);
    if (order === null) throw new Unappliable(`no order for payment event ${eventId}`);

    const now = this.clock.now();
    await this.applyTo(transaction, order, row, now);
    await orders.save(order);
    await writeSeatOrderIntegrationEvents(manager, order.getUncommittedEvents(), {
      traceparent: row.traceparent,
    });
    await manager.query('UPDATE stripe_event_inbox SET applied_at = $2 WHERE event_id = $1', [
      eventId,
      new Date(now),
    ]);
    return order.snapshot.id;
  }

  private async applyTo(
    transaction: TicketingTransaction,
    order: SeatOrder,
    { kind, intent_ref: intentRef, decline_code: declineCode }: InboxRow,
    now: Instant,
  ): Promise<void> {
    const intent = { ref: intentRef ?? '', clientSecret: null, nextAction: null };
    switch (kind) {
      case PaymentEventKind.INTENT_SUCCEEDED:
        if (intentRef === null) throw new Unappliable('a confirmation names no intent');
        await settleConfirmedPayment(transaction, order, intentRef, now);
        return;
      case PaymentEventKind.INTENT_REQUIRES_ACTION:
        order.recordIntent(intent, OrderState.AWAITING_ACTION, now);
        return;
      case PaymentEventKind.INTENT_PROCESSING:
        order.recordIntent(intent, OrderState.PROCESSING, now);
        return;
      case PaymentEventKind.INTENT_FAILED:
        await failUnpaidOrder(
          transaction,
          order,
          { code: OrderErrorCode.PAYMENT_DECLINED, declineCode },
          now,
        );
        return;
      case PaymentEventKind.INTENT_CANCELED:
        await failUnpaidOrder(transaction, order, { code: null, declineCode: null }, now);
        return;
      case PaymentEventKind.UNHANDLED:
        return;
    }
  }

  /** At once, outside the transaction that found the debt (D-082); the worker asks again if not. */
  private async refundIfOwed(orderId: string): Promise<void> {
    try {
      await this.refunds.refund(orderId);
    } catch (error) {
      this.logger.error(
        `refund owed by order ${orderId} not made yet`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async failed(eventId: string, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    const [row] = await this.dataSource.query<{ attempts: number }[]>(
      `UPDATE stripe_event_inbox SET attempts = attempts + 1, last_error = $2
        WHERE event_id = $1
        RETURNING attempts`,
      [eventId, reason.slice(0, 1_000)],
    );
    const attempts = row?.attempts ?? 1;
    const delay = RETRY_DELAYS_MS[attempts - 1];
    const now = this.clock.nowMs();
    if (error instanceof Unappliable || delay === undefined) {
      await this.dataSource.query(
        'UPDATE stripe_event_inbox SET dead_at = $2 WHERE event_id = $1',
        [eventId, new Date(now)],
      );
      this.logger.error(
        `payment event ${eventId} given up on after ${String(attempts)}: ${reason}`,
      );
      return;
    }
    const retryAt = now + delay + Math.floor(delay * JITTER_RATIO * Math.random());
    await this.dataSource.query('UPDATE stripe_event_inbox SET retry_at = $2 WHERE event_id = $1', [
      eventId,
      new Date(retryAt),
    ]);
    this.logger.warn(`payment event ${eventId} not applied, retried later: ${reason}`);
  }
}
