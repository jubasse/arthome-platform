import {
  OrderKind,
  type Instant,
  type Money,
  type PriceTier,
  type RefundDelayCode,
  RefundMethod,
  type RefundReason,
  OrderState,
  SeatState,
  refundDelayCodeOf,
} from '@arthome/core';

import { ORDER_STATES_AWAITING_PAYMENT } from './awaiting-payment.js';
import type { OrderRefund, SeatOrderSnapshot, SeatSnapshot } from './seat-order.aggregate.js';
import { type NextAction } from '../payments/next-action.js';

/**
 * storefront.yaml's `TicketCard` but its `date`, catalog's `DateCard`, which ticketing cannot build
 *   without calling catalog (critical rule 1): the BFF adds it.
 */
export interface TicketView {
  readonly seatId: string;
  readonly dateId: string;
  readonly orderId: string;
  readonly seatCode: string;
  readonly tier: PriceTier;
  readonly state: SeatState;
  readonly cancelDeadline: Instant | null;
  readonly refund: TicketRefundView | null;
}

/** `TicketCard.refund`: what the viewer gets back, and where. */
export interface TicketRefundView {
  readonly amount: Money;
  readonly delayCode: RefundDelayCode | null;
  readonly method: RefundMethod;
  readonly refundReasonCode: RefundReason | null;
}

/** storefront.yaml's `Order`. */
export interface OrderView {
  readonly id: string;
  readonly reference: string;
  readonly kind: OrderKind;
  readonly channelId: string;
  readonly state: OrderState;
  readonly total: Money;
  readonly placedAt: Instant;
  readonly refundReasonCode?: RefundReason;
}

/** storefront.yaml's `PaymentHandoff`: its `expiresAt` is the hold's (adr-ticketing.md §2). */
export interface PaymentHandoffView {
  readonly orderId: string;
  readonly state: OrderState;
  readonly paymentIntentRef: string;
  readonly clientSecret: string;
  readonly nextAction: NextAction | null;
  readonly returnUrl: string;
  readonly expiresAt: Instant;
}

/** `purchaseSeat`'s 201 but the `date`, which the BFF adds. */
export interface PurchasedSeats {
  readonly tickets: readonly TicketView[];
  readonly order: OrderView;
}

/** `getOrder`'s body. */
export interface OrderDetail {
  readonly order: OrderView;
  readonly tickets: readonly TicketView[];
  readonly handoff?: PaymentHandoffView;
}

const STATES_SERVING_REFUND_REASON: readonly OrderState[] = [
  OrderState.REFUNDED,
  OrderState.PARTIALLY_REFUNDED,
];

export function orderViewOf(order: SeatOrderSnapshot): OrderView {
  const refunded = STATES_SERVING_REFUND_REASON.includes(order.state)
    ? latestRefundMade(order)
    : undefined;
  return {
    id: order.id,
    reference: order.reference,
    kind: OrderKind.SEAT,
    channelId: order.channelId,
    state: order.state,
    total: order.quote.total,
    placedAt: order.placedAt,
    ...(refunded !== undefined && { refundReasonCode: refunded.reason }),
  };
}

function latestRefundMade({ refunds }: SeatOrderSnapshot): OrderRefund | undefined {
  return refunds
    .filter(({ refundedAt }) => refundedAt !== null)
    .reduce<OrderRefund | undefined>(
      (latest, refund) =>
        latest === undefined || (refund.refundedAt ?? '') > (latest.refundedAt ?? '')
          ? refund
          : latest,
      undefined,
    );
}

/** In the order of their codes, as every read serves them. */
export function ticketViewsOf(order: SeatOrderSnapshot): TicketView[] {
  const byCode = [...order.seats].sort((left, right) => left.code.localeCompare(right.code));
  return byCode.map((seat) => ({
    seatId: seat.id,
    dateId: order.dateId,
    orderId: order.id,
    seatCode: seat.code,
    tier: seat.tier,
    state: seat.state,
    cancelDeadline: seat.cancelDeadline,
    refund: ticketRefundOf(seat, order.refunds),
  }));
}

/**
 * Null while active, and once cancelled with nothing given back (a disputed order, nothing left);
 *   the refund's share from the cancellation on, the provider's delay with it; a credit's share.
 */
function ticketRefundOf(
  seat: SeatSnapshot,
  refunds: readonly OrderRefund[],
): TicketRefundView | null {
  if (seat.state === SeatState.CREDITED && seat.creditAmount !== null) {
    return {
      amount: seat.creditAmount,
      delayCode: refundDelayCodeOf(RefundMethod.ACCOUNT_CREDIT),
      method: RefundMethod.ACCOUNT_CREDIT,
      refundReasonCode: null,
    };
  }
  const refund = refunds.find(({ id }) => id === seat.refundId);
  if (seat.refundAmount === null || refund === undefined) return null;
  return {
    amount: seat.refundAmount,
    delayCode: refundDelayCodeOf(RefundMethod.ORIGINAL_PAYMENT_METHOD),
    method: RefundMethod.ORIGINAL_PAYMENT_METHOD,
    refundReasonCode: refund.reason,
  };
}

/** One seat's card, as `ticketViewsOf` serves it among its order's. */
export function ticketViewOf(order: SeatOrderSnapshot, seatId: string): TicketView {
  const ticket = ticketViewsOf(order).find((view) => view.seatId === seatId);
  if (ticket === undefined) throw new Error(`order ${order.id} holds no seat ${seatId}`);
  return ticket;
}

/** Null once the order stopped waiting for the buyer, or for an intent that carries no secret. */
export function handoffOf(order: SeatOrderSnapshot, returnUrl: string): PaymentHandoffView | null {
  const { intent } = order;
  if (intent?.clientSecret == null || !ORDER_STATES_AWAITING_PAYMENT.includes(order.state))
    return null;
  return {
    orderId: order.id,
    state: order.state,
    paymentIntentRef: intent.ref,
    clientSecret: intent.clientSecret,
    nextAction: intent.nextAction,
    returnUrl,
    expiresAt: order.expiresAt,
  };
}
