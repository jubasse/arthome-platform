import { notFound, runIdempotently, type MemorisedResponse } from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { v7 as uuidv7 } from 'uuid';

import {
  OrderState,
  RefundReason,
  assertSeatCancellable,
  refundIdempotencyKey,
  refundReasonOnDate,
  type Clock,
  type Instant,
} from '@arthome/core';

import { CancelSeat, type SeatCancellationView } from './cancel-seat.command.js';
import { seatOwnerOf } from './seat-owner.js';
import { seatCancelReasonFor, seatOf, seatShareWithin } from './seat-share.js';
import { CLOCK } from '../clock.js';
import { ticketViewOf } from '../orders/order-views.js';
import { writeSeatOrderIntegrationEvents } from '../orders/seat-order-integration-events.js';
import type { OrderRefund, SeatOrder } from '../orders/seat-order.aggregate.js';
import type { PendingCounterMove } from '../orders/settle-payment.js';
import { recordRefundTraceparent } from '../payments/refund-ledger.js';
import { TicketingTransactions, type TicketingTransaction } from '../ticketing-transactions.js';

interface Cancelled {
  readonly answer: SeatCancellationView;
  readonly release: PendingCounterMove | null;
}

/**
 * A viewer's own seat, cancelled before its deadline and refunded its share (adr-payments.md §9),
 *   the seat back on sale at once (D-093). The order is locked before its seats and refund rows,
 *   the date's outcome read unlocked, and the seat's return to sale is the transaction's last
 *   statement, after the outbox rows and the kept answer, so the hot row is held for the commit
 *   alone. Nothing calls the provider: the worker's queue makes the refund.
 */
@CommandHandler(CancelSeat)
export class CancelSeatHandler implements ICommandHandler<CancelSeat> {
  public constructor(
    private readonly transactions: TicketingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute(command: CancelSeat): Promise<MemorisedResponse<SeatCancellationView>> {
    return this.transactions.run(async (transaction) => {
      const releases: PendingCounterMove[] = [];
      const response = await runIdempotently(
        transaction.manager,
        command.idempotency,
        this.clock,
        async () => {
          const { answer, release } = await this.cancelIn(transaction, command);
          if (release !== null) releases.push(release);
          return answer;
        },
      );
      for (const release of releases) await release();
      return response;
    });
  }

  private async cancelIn(
    { manager, orders, dateSales }: TicketingTransaction,
    { seatId, accountId, traceparent }: CancelSeat,
  ): Promise<Cancelled> {
    const owner = await seatOwnerOf(manager, seatId);
    if (owner?.accountId !== accountId) throw notFound();
    const order = await orders.findById(owner.orderId);
    if (order === null) throw notFound();
    const seat = seatOf(order.snapshot, seatId);
    const { dateId } = order.snapshot;
    const now = this.clock.now();

    const sales = await dateSales.findUnlocked(dateId);
    const reason = refundReasonOnDate(sales?.snapshot.outcome ?? null, RefundReason.VIEWER_REQUEST);
    // A cancelled date owes its refund whatever the deadline says, and has no sale to return to.
    const onCancelledDate = reason === RefundReason.DATE_CANCELLED;
    assertSeatCancellable(onCancelledDate ? { ...seat, cancelDeadline: null } : seat, now);

    const refund = this.oweShare(order, seatId, reason, now);
    order.cancelSeats(
      {
        reason: seatCancelReasonFor(reason),
        refundId: refund?.id ?? null,
        seats: [{ seatId, refundAmount: refund?.amount ?? null }],
      },
      now,
    );
    await orders.save(order);
    if (refund !== null) await recordRefundTraceparent(manager, refund.id, traceparent);
    await writeSeatOrderIntegrationEvents(manager, order.getUncommittedEvents(), { traceparent });

    return {
      answer: { ticket: ticketViewOf(order.snapshot, seatId) },
      release: onCancelledDate
        ? null
        : async () => {
            if (!(await dateSales.releaseSoldSeats(dateId, 1))) {
              throw new Error(`date ${dateId} sold no seat to give back for seat ${seatId}`);
            }
          },
    };
  }

  /**
   * The seat's share, capped at what is left; nothing on a disputed order, whose money the
   *   provider holds ("nothing on the viewer's side", adr-payments.md §9), nor once nothing is left.
   */
  private oweShare(
    order: SeatOrder,
    seatId: string,
    reason: RefundReason,
    now: Instant,
  ): OrderRefund | null {
    if (order.snapshot.state === OrderState.DISPUTED) return null;
    const amount = seatShareWithin(order.snapshot, seatId, order.refundableLeft);
    if (amount.amountMinor === 0) return null;
    const id = uuidv7();
    return order.oweRefund(
      { id, amount, reason, idempotencyKey: refundIdempotencyKey(id), seatId },
      now,
    );
  }
}
