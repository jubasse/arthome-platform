import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { OrderErrorCode, type Clock, type Instant } from '@arthome/core';

import { ApplyPaymentEvents } from './apply-payment-events.command.js';
import { nextAttemptAt } from './owed-calls.js';
import { OwedRefunds } from './owed-refunds.js';
import { PaymentEventKind } from './payment.port.js';
import { CLOCK } from '../clock.js';
import { OrderState } from '../orders/commerce-vocabulary.js';
import { failUnpaidOrder } from '../orders/fail-unpaid-order.js';
import { writeSeatOrderIntegrationEvents } from '../orders/seat-order-integration-events.js';
import type { SeatOrder } from '../orders/seat-order.aggregate.js';
import { settleConfirmedPayment, type PendingCounterMove } from '../orders/settle-payment.js';
import { TicketingTransactions, type TicketingTransaction } from '../ticketing-transactions.js';

interface InboxRow {
  readonly event_id: string;
  readonly kind: PaymentEventKind;
  readonly intent_ref: string | null;
  readonly order_id: string | null;
  readonly decline_code: string | null;
  readonly traceparent: string | null;
}

/** An event that no retry can apply: it names an order this service does not hold. */
class Unappliable extends Error {}

/** What an applied event leaves to do after its transaction. */
interface Applied {
  readonly orderId: string;
  readonly owesRefund: boolean;
}

/**
 * adr-ticketing.md §8's worker, each recorded webhook in a transaction of its own (HANDOVER §0j): the
 *   row claimed `SKIP LOCKED`, the order moved forward only, the row marked applied with the effect.
 *   A failure is retried after the consumers' delays, then given up on as its own dead letter.
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

  /** Answers how many events it applied or gave up on; one retried later does not count. */
  public async execute({ batch }: ApplyPaymentEvents): Promise<number> {
    const due = await this.dataSource.query<{ event_id: string }[]>(
      `SELECT event_id FROM stripe_event_inbox
        WHERE applied_at IS NULL AND dead_at IS NULL AND (retry_at IS NULL OR retry_at <= $1)
        ORDER BY received_at
        LIMIT $2`,
      [new Date(this.clock.now()), batch],
    );
    let settled = 0;
    for (const { event_id } of due) {
      let applied: Applied | null | undefined;
      try {
        applied = await this.transactions.run((transaction) => this.applyIn(transaction, event_id));
      } catch (error) {
        if (await this.failed(event_id, error)) settled += 1;
        continue;
      }
      if (applied !== undefined) settled += 1;
      if (applied?.owesRefund === true) await this.refundAtOnce(applied.orderId);
    }
    return settled;
  }

  /**
   * What the event did to its order, null for an event about no order of this service's (kept,
   *   applied as nothing), undefined when another pass holds the row or already applied it.
   */
  private async applyIn(
    transaction: TicketingTransaction,
    eventId: string,
  ): Promise<Applied | null | undefined> {
    const { manager, orders } = transaction;
    const [row] = await manager.query<InboxRow[]>(
      `SELECT event_id, kind, intent_ref, order_id, decline_code, traceparent
         FROM stripe_event_inbox
        WHERE event_id = $1 AND applied_at IS NULL AND dead_at IS NULL
          FOR UPDATE SKIP LOCKED`,
      [eventId],
    );
    if (row === undefined) return undefined;
    const now = this.clock.now();
    const markApplied = () =>
      manager.query('UPDATE stripe_event_inbox SET applied_at = $2 WHERE event_id = $1', [
        eventId,
        new Date(now),
      ]);
    if (row.kind === PaymentEventKind.UNHANDLED || row.order_id === null) {
      await markApplied();
      return null;
    }
    const order = await orders.findById(row.order_id);
    if (order === null) throw new Unappliable(`no order for payment event ${eventId}`);

    const pending = await this.applyTo(transaction, order, row, now);
    await orders.save(order);
    await writeSeatOrderIntegrationEvents(manager, order.getUncommittedEvents(), {
      traceparent: row.traceparent,
    });
    await markApplied();
    await pending?.();
    return { orderId: order.snapshot.id, owesRefund: order.owesRefund };
  }

  /** The counter move to run last, if the event moved seats. */
  private async applyTo(
    transaction: TicketingTransaction,
    order: SeatOrder,
    row: InboxRow,
    now: Instant,
  ): Promise<PendingCounterMove | null> {
    const { kind, intent_ref: intentRef, decline_code: declineCode } = row;
    const intent = { ref: intentRef ?? '', clientSecret: null, nextAction: null };
    switch (kind) {
      case PaymentEventKind.INTENT_SUCCEEDED:
        if (intentRef === null) throw new Unappliable('a confirmation names no intent');
        return settleConfirmedPayment(transaction, order, intentRef, now, row.traceparent);
      case PaymentEventKind.INTENT_REQUIRES_ACTION:
        order.recordIntent(intent, OrderState.AWAITING_ACTION, now);
        return null;
      case PaymentEventKind.INTENT_PROCESSING:
        order.recordIntent(intent, OrderState.PROCESSING, now);
        return null;
      case PaymentEventKind.INTENT_FAILED:
        return failUnpaidOrder(
          transaction,
          order,
          { code: OrderErrorCode.PAYMENT_DECLINED, declineCode },
          now,
        );
      case PaymentEventKind.INTENT_CANCELED:
        return failUnpaidOrder(transaction, order, { code: null, declineCode: null }, now);
      case PaymentEventKind.UNHANDLED:
        return null;
    }
  }

  /** Outside the transaction that found the debt (D-082); the worker's claimed attempts follow. */
  private async refundAtOnce(orderId: string): Promise<void> {
    try {
      await this.refunds.refund(orderId);
    } catch (error) {
      this.logger.error(
        `refund owed by order ${orderId} not made yet`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** True when given up on: the event is settled, as a dead letter (adr-payments.md §7.4). */
  private async failed(eventId: string, error: unknown): Promise<boolean> {
    const reason = error instanceof Error ? error.message : String(error);
    // An UPDATE answers `[rows, rowCount]` through TypeORM, never the rows alone.
    const [[row]] = await this.dataSource.query<[{ attempts: number }[], number]>(
      `UPDATE stripe_event_inbox SET attempts = attempts + 1, last_error = $2
        WHERE event_id = $1
        RETURNING attempts`,
      [eventId, reason.slice(0, 1_000)],
    );
    const attempts = row?.attempts ?? 1;
    const nowMs = this.clock.nowMs();
    const retryAt = error instanceof Unappliable ? null : nextAttemptAt(attempts, nowMs);
    if (retryAt === null) {
      await this.dataSource.query(
        'UPDATE stripe_event_inbox SET dead_at = $2, retry_at = NULL WHERE event_id = $1',
        [eventId, new Date(nowMs)],
      );
      this.logger.error(
        `payment event ${eventId} given up on after ${String(attempts)} attempts: ${reason}`,
      );
      return true;
    }
    await this.dataSource.query('UPDATE stripe_event_inbox SET retry_at = $2 WHERE event_id = $1', [
      eventId,
      retryAt,
    ]);
    this.logger.warn(
      `payment event ${eventId} not applied, attempt ${String(attempts)}: ${reason}`,
    );
    return false;
  }
}
