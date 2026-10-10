import {
  notFound,
  refusalOf,
  runIdempotently,
  type MemorisedResponse,
} from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { v7 as uuidv7 } from 'uuid';

import {
  DateOutcome,
  DomainErrorCode,
  OrderErrorCode,
  OrderState,
  RefundReason,
  SeatState,
  assertRefundWithinRemaining,
  money,
  refundCancelsSeat,
  refundIdempotencyKey,
  type Clock,
  type Money,
} from '@arthome/core';

import { RefundSeat, type SeatRefundView } from './refund-seat.command.js';
import type { RefundSeatBody } from './refund-seat.schema.js';
import { seatOwnerOf } from './seat-owner.js';
import { seatCancelReasonFor, seatOf, seatShareWithin } from './seat-share.js';
import { CLOCK } from '../clock.js';
import { writeSeatOrderIntegrationEvents } from '../orders/seat-order-integration-events.js';
import type { SeatOrder } from '../orders/seat-order.aggregate.js';
import { recordRefundTraceparent } from '../payments/refund-ledger.js';
import { TicketingTransactions, type TicketingTransaction } from '../ticketing-transactions.js';

/**
 * The studio refunds an active seat, wholly or in part, never past what is left on its order. Only
 *   `date_cancelled` cancels it, and only on a date a cancellation closed (D-095, D-097); a
 *   `goodwill`, `duplicate` or `dispute` refund leaves it active whatever the amount. The order is
 *   locked before its seats and refund rows, the date read unlocked; no counter moves, and the
 *   worker's queue makes the refund.
 */
@CommandHandler(RefundSeat)
export class RefundSeatHandler implements ICommandHandler<RefundSeat> {
  public constructor(
    private readonly transactions: TicketingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute(command: RefundSeat): Promise<MemorisedResponse<SeatRefundView>> {
    return this.transactions.run((transaction) =>
      runIdempotently(transaction.manager, command.idempotency, this.clock, () =>
        this.refundIn(transaction, command),
      ),
    );
  }

  private async refundIn(
    { manager, orders, dateSales }: TicketingTransaction,
    { seatId, body, traceparent }: RefundSeat,
  ): Promise<SeatRefundView> {
    const owner = await seatOwnerOf(manager, seatId);
    if (owner === null) throw notFound();
    const order = await orders.findById(owner.orderId);
    if (order === null) throw notFound();
    const { state, version, dateId } = order.snapshot;
    const seat = seatOf(order.snapshot, seatId);
    if (seat.state !== SeatState.ACTIVE) {
      throw refusalOf(OrderErrorCode.SEAT_NOT_ACTIVE, { state: seat.state });
    }
    if (state === OrderState.DISPUTED) {
      throw refusalOf(DomainErrorCode.STATE_CONFLICT, { currentVersion: version, state });
    }
    const reason = body.refundReasonCode;
    if (reason === RefundReason.DATE_CANCELLED) {
      const sales = await dateSales.findUnlocked(dateId);
      if (sales === null) throw new Error(`order ${order.snapshot.id} sold a date with no sale`);
      const { outcome, version: salesVersion } = sales.snapshot;
      if (outcome !== DateOutcome.CANCELLED) {
        throw refusalOf(DomainErrorCode.STATE_CONFLICT, {
          currentVersion: salesVersion,
          ...(outcome !== null && { state: outcome }),
        });
      }
    }

    const now = this.clock.now();
    const amount = amountToRefund(order, seatId, body);
    const id = uuidv7();
    order.oweRefund({ id, amount, reason, idempotencyKey: refundIdempotencyKey(id), seatId }, now);
    if (refundCancelsSeat(reason)) {
      order.cancelSeats(
        {
          reason: seatCancelReasonFor(reason),
          refundId: id,
          seats: [{ seatId, refundAmount: amount }],
        },
        now,
      );
    }
    await orders.save(order);
    await recordRefundTraceparent(manager, id, traceparent);
    await writeSeatOrderIntegrationEvents(manager, order.getUncommittedEvents(), { traceparent });
    return { refunded: amount, payoutId: null };
  }
}

/**
 * The amount asked, else the seat's share capped at what is left; refused past what is left, and
 *   when nothing is.
 */
function amountToRefund(order: SeatOrder, seatId: string, body: RefundSeatBody): Money {
  const left = order.refundableLeft;
  const { partialAmountMinor } = body;
  const amount =
    partialAmountMinor == null
      ? seatShareWithin(order.snapshot, seatId, left)
      : money(partialAmountMinor, left.currencyCode);
  assertRefundWithinRemaining(amount, left);
  if (amount.amountMinor === 0) {
    throw refusalOf(OrderErrorCode.REFUND_AMOUNT_EXCEEDS_REMAINING, {
      remainingMinor: 0,
      currencyCode: left.currencyCode,
    });
  }
  return amount;
}
