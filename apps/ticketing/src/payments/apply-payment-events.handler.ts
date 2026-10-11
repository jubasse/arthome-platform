import { nextAttemptAt } from '@arthome-platform/messaging';
import { updateReturning } from '@arthome-platform/transactions';
import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  OrderErrorCode,
  money,
  type Clock,
  type Instant,
  OrderState,
  PaymentEventKind,
} from '@arthome/core';

import { ApplyPaymentEvents } from './apply-payment-events.command.js';
import { askRefundCallsAgain } from './refund-ledger.js';
import { CLOCK } from '../clock.js';
import { failUnpaidOrder } from '../orders/fail-unpaid-order.js';
import { recordWaitingIntent } from '../orders/record-waiting-intent.js';
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
  readonly refund_ref: string | null;
  readonly amount_refunded_minor: string | null;
  readonly amount_refunded_currency_code: string | null;
}

/** An event that no retry can apply: it names an order this service does not hold. */
class Unappliable extends Error {}

const KINDS_APPLIED_AS_NOTHING: readonly PaymentEventKind[] = [PaymentEventKind.UNHANDLED];

/**
 * adr-ticketing.md §8's worker, each recorded webhook in a transaction of its own (HANDOVER §0j): the
 *   row claimed `SKIP LOCKED`, the order moved forward only, the row marked applied with the effect.
 *   A failure is retried after the consumers' delays, then given up on as its own dead letter. A
 *   refund the event owes (D-082) is a row of that transaction, made by the worker's queue; a
 *   refund the provider reports made, and a dispute, are applied here too (HANDOVER §0o).
 */
@CommandHandler(ApplyPaymentEvents)
export class ApplyPaymentEventsHandler implements ICommandHandler<ApplyPaymentEvents> {
  private readonly logger = new Logger(ApplyPaymentEventsHandler.name);

  public constructor(
    private readonly transactions: TicketingTransactions,
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
      try {
        if (await this.transactions.run((transaction) => this.applyIn(transaction, event_id))) {
          settled += 1;
        }
      } catch (error) {
        if (await this.failed(event_id, error)) settled += 1;
      }
    }
    return settled;
  }

  /**
   * True once applied, an event about no order of this service's included (kept, applied as
   *   nothing); false when another pass holds the row or already applied it.
   */
  private async applyIn(transaction: TicketingTransaction, eventId: string): Promise<boolean> {
    const { manager, orders } = transaction;
    const [row] = await manager.query<InboxRow[]>(
      `SELECT event_id, kind, intent_ref, order_id, decline_code, traceparent, refund_ref,
              amount_refunded_minor, amount_refunded_currency_code
         FROM stripe_event_inbox
        WHERE event_id = $1 AND applied_at IS NULL AND dead_at IS NULL
          FOR UPDATE SKIP LOCKED`,
      [eventId],
    );
    if (row === undefined) return false;
    const now = this.clock.now();
    const markApplied = () =>
      manager.query('UPDATE stripe_event_inbox SET applied_at = $2 WHERE event_id = $1', [
        eventId,
        new Date(now),
      ]);
    if (KINDS_APPLIED_AS_NOTHING.includes(row.kind) || row.order_id === null) {
      await markApplied();
      return true;
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
    return true;
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
        await recordWaitingIntent(transaction, order, intent, OrderState.AWAITING_ACTION, now);
        return null;
      case PaymentEventKind.INTENT_PROCESSING:
        await recordWaitingIntent(transaction, order, intent, OrderState.PROCESSING, now);
        return null;
      case PaymentEventKind.INTENT_FAILED:
        return failUnpaidOrder(
          transaction,
          order,
          { code: OrderErrorCode.PAYMENT_DECLINED, declineCode },
          now,
        );
      case PaymentEventKind.INTENT_CANCELLED:
        return failUnpaidOrder(transaction, order, { code: null, declineCode: null }, now);
      case PaymentEventKind.REFUND_SUCCEEDED:
        await this.rerunRefundsReported(transaction, order, row, now);
        return null;
      case PaymentEventKind.DISPUTE_OPENED:
        return this.applyDispute(transaction, order, row, now);
      case PaymentEventKind.UNHANDLED:
        return null;
    }
  }

  /**
   * Marks no refund made (R15, replaced): asks the relay to re-run now the call of each refund still
   *   owed that the cumulative amount could cover. The provider answers under the refund's key, and
   *   the processor marks it made with the provider's own reference.
   */
  private async rerunRefundsReported(
    { manager }: TicketingTransaction,
    order: SeatOrder,
    row: InboxRow,
    now: Instant,
  ): Promise<void> {
    const { amount_refunded_minor: minor, amount_refunded_currency_code: currencyCode } = row;
    if (minor === null || currencyCode === null) {
      throw new Unappliable('a refund made carries no amount refunded');
    }
    const amountRefunded = money(Number(minor), currencyCode);
    const refundIds = order.refundsTheProviderMayHaveMade(amountRefunded);
    if (refundIds === null) {
      this.logger.warn(
        `payment event ${row.event_id}: ${String(amountRefunded.amountMinor)} ${currencyCode} ` +
          `refunded on order ${order.snapshot.id}, more than every refund it holds; a refund ` +
          'made outside the platform, kept and ignored',
      );
      return;
    }
    await askRefundCallsAgain(manager, refundIds, now);
  }

  /**
   * The order `disputed`, its seats left active and nothing asked of anyone (adr-payments.md §9).
   *   A dispute reaching an order not yet paid settles its payment first, as a confirmation would:
   *   a disputed charge is a charge that was taken.
   */
  private async applyDispute(
    transaction: TicketingTransaction,
    order: SeatOrder,
    row: InboxRow,
    now: Instant,
  ): Promise<PendingCounterMove | null> {
    if (row.intent_ref === null) throw new Unappliable('a dispute names no intent');
    const pending = await settleConfirmedPayment(
      transaction,
      order,
      row.intent_ref,
      now,
      row.traceparent,
    );
    order.dispute();
    return pending;
  }

  /** True when given up on: the event is settled, as a dead letter (adr-payments.md §7.4). */
  private async failed(eventId: string, error: unknown): Promise<boolean> {
    const reason = error instanceof Error ? error.message : String(error);
    const [row] = await updateReturning<{ attempts: number }>(
      this.dataSource,
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
