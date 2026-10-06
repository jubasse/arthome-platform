import {
  compare,
  seatCancelReasonOf,
  seatSharesOf,
  type Money,
  type RefundReason,
  type SeatCancelReason,
} from '@arthome/core';

import type { SeatOrderSnapshot, SeatSnapshot } from '../orders/seat-order.aggregate.js';

export function seatOf(order: SeatOrderSnapshot, seatId: string): SeatSnapshot {
  const seat = order.seats.find(({ id }) => id === seatId);
  if (seat === undefined) throw new Error(`order ${order.id} holds no seat ${seatId}`);
  return seat;
}

/**
 * The seat's entry of its order's total split over its seats in id order, as a whole order's
 *   refund or credit is split, capped at what is left to refund.
 */
export function seatShareWithin(
  order: SeatOrderSnapshot,
  seatId: string,
  refundableLeft: Money,
): Money {
  const seatIds = order.seats.map(({ id }) => id).sort();
  const share = seatSharesOf(order.quote.total, order.quantity)[seatIds.indexOf(seatId)];
  if (share === undefined) throw new Error(`order ${order.id} holds no seat ${seatId}`);
  return compare(share, refundableLeft) > 0 ? refundableLeft : share;
}

/** For a refund that cancels its seat (D-095): a viewer's, a cancelled date's. */
export function seatCancelReasonFor(reason: RefundReason): SeatCancelReason {
  const cancelReason = seatCancelReasonOf(reason);
  if (cancelReason === null) throw new Error(`a ${reason} refund cancels no seat`);
  return cancelReason;
}
