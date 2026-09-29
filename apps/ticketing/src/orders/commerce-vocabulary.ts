/**
 * The vocabularies of a seat purchase, held here until core carries them (HANDOVER §3). The
 *   storefront contract declares the order and ticket states as its own; the domain needs them to
 *   decide, so they are core's to own.
 */

import type { OrderErrorCode } from '@arthome/core';

import type { INTERIM_SALES_CLOSED } from '../date-sales/seat-sales-window.js';

/** adr-payments.md §8, in the contract's order. */
export const ORDER_STATES = [
  'pending',
  'awaiting_action',
  'processing',
  'paid',
  'failed',
  'refunded',
  'partially_refunded',
  'disputed',
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const OrderState = {
  PENDING: 'pending',
  AWAITING_ACTION: 'awaiting_action',
  PROCESSING: 'processing',
  PAID: 'paid',
  FAILED: 'failed',
  REFUNDED: 'refunded',
  PARTIALLY_REFUNDED: 'partially_refunded',
  DISPUTED: 'disputed',
} as const;

/**
 * adr-payments.md §7.3's ranks: a transition is applied only if it moves forward. `failed` ranks
 *   below `paid`, because a payment confirmed after its hold expired still pays the order (D-082).
 */
const ORDER_STATE_RANK: Readonly<Record<OrderState, number>> = {
  [OrderState.PENDING]: 0,
  [OrderState.AWAITING_ACTION]: 1,
  [OrderState.PROCESSING]: 2,
  [OrderState.FAILED]: 3,
  [OrderState.PAID]: 4,
  [OrderState.PARTIALLY_REFUNDED]: 5,
  [OrderState.REFUNDED]: 6,
  [OrderState.DISPUTED]: 7,
};

export function movesForward(from: OrderState, to: OrderState): boolean {
  return ORDER_STATE_RANK[to] > ORDER_STATE_RANK[from];
}

/** An order still waiting for its payment: the only states a payment's failure or expiry moves. */
export const ORDER_STATES_AWAITING_PAYMENT: readonly OrderState[] = [
  OrderState.PENDING,
  OrderState.AWAITING_ACTION,
  OrderState.PROCESSING,
];

/** What a replay of a failed purchase answers: core's codes, and D-089's closed sale until core has it. */
export type OrderFailureCode = OrderErrorCode | typeof INTERIM_SALES_CLOSED;

/** data-model.md §3.3, `held` gone (D-077). */
export const SEAT_STATES = ['active', 'cancelled', 'refunded', 'transferred', 'credited'] as const;
export type SeatState = (typeof SEAT_STATES)[number];

export const SeatState = {
  ACTIVE: 'active',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
  TRANSFERRED: 'transferred',
  CREDITED: 'credited',
} as const;

/** data-model.md §3.2. */
export const SEAT_HOLD_STATES = ['active', 'consumed', 'expired', 'released'] as const;
export type SeatHoldState = (typeof SEAT_HOLD_STATES)[number];

export const SeatHoldState = {
  ACTIVE: 'active',
  CONSUMED: 'consumed',
  EXPIRED: 'expired',
  RELEASED: 'released',
} as const;

/** data-model.md §3.2: a checkout session or a TV pairing, whose expiry the hold's is. */
export const SEAT_HOLD_ORIGINS = ['checkout', 'pairing'] as const;
export type SeatHoldOrigin = (typeof SEAT_HOLD_ORIGINS)[number];

export const SeatHoldOrigin = {
  CHECKOUT: 'checkout',
  PAIRING: 'pairing',
} as const;
