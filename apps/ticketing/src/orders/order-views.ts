import {
  OrderKind,
  type Instant,
  type Money,
  type PriceTier,
  type RefundReason,
} from '@arthome/core';

import {
  ORDER_STATES_AWAITING_PAYMENT,
  OrderState,
  type SeatState,
} from './commerce-vocabulary.js';
import type { SeatOrderSnapshot } from './seat-order.aggregate.js';
import type { NextAction } from '../payments/payment.port.js';

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

export function orderViewOf(order: SeatOrderSnapshot): OrderView {
  return {
    id: order.id,
    reference: order.reference,
    kind: OrderKind.SEAT,
    channelId: order.channelId,
    state: order.state,
    total: order.quote.total,
    placedAt: order.placedAt,
    ...(order.state === OrderState.REFUNDED &&
      order.refund !== null && { refundReasonCode: order.refund.reason }),
  };
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
  }));
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
