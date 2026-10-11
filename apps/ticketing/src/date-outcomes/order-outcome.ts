import {
  CreditOrigin,
  OrderState,
  RefundReason,
  SeatCancelReason,
  SeatState,
  creditAmountFor,
  refundIdempotencyKey,
  seatSharesOf,
  type Money,
} from '@arthome/core';

import type { CreditIssue } from '../credits/credit.aggregate.js';
import type {
  OwedRefund,
  SeatCancellation,
  SeatCrediting,
  SeatOrder,
  SeatSnapshot,
} from '../orders/seat-order.aggregate.js';

/**
 * An order holds the money it took while `paid` or `partially_refunded`: a `disputed` one's is the
 *   provider's (adr-payments.md §9), a `refunded` one's is gone.
 */
const STATES_HOLDING_MONEY: readonly OrderState[] = [
  OrderState.PAID,
  OrderState.PARTIALLY_REFUNDED,
];

/** In seat-id order, the order the shares are split in. */
function activeSeatsOf(order: SeatOrder): readonly SeatSnapshot[] {
  return order.snapshot.seats
    .filter(({ state }) => state === SeatState.ACTIVE)
    .sort((one, other) => one.id.localeCompare(other.id));
}

/** Each seat with its share of `total`, both in seat-id order. */
function sharedOver(
  seats: readonly SeatSnapshot[],
  total: Money,
): readonly (readonly [SeatSnapshot, Money])[] {
  const shares = seatSharesOf(total, seats.length);
  return seats.map((seat, index) => {
    const share = shares[index];
    if (share === undefined)
      throw new Error(`no share of ${String(total.amountMinor)} for ${seat.id}`);
    return [seat, share];
  });
}

function moneyLeftOf(order: SeatOrder): Money | null {
  if (!STATES_HOLDING_MONEY.includes(order.snapshot.state)) return null;
  const left = order.refundableLeft;
  return left.amountMinor > 0 ? left : null;
}

export interface CancelledDateSettlement {
  /** Null when nothing is left to give back. */
  readonly refund: OwedRefund | null;
  readonly cancellation: SeatCancellation;
}

/**
 * A cancelled date's order (adr-ticketing.md §8): what is left of its money in one refund, under
 *   `refundId`, its active seats cancelled with their shares of it. Null with no seat active.
 */
export function cancelledDateSettlementOf(
  order: SeatOrder,
  refundId: string,
): CancelledDateSettlement | null {
  const seats = activeSeatsOf(order);
  if (seats.length === 0) return null;
  const left = moneyLeftOf(order);
  return {
    refund:
      left === null
        ? null
        : {
            id: refundId,
            amount: left,
            reason: RefundReason.DATE_CANCELLED,
            idempotencyKey: refundIdempotencyKey(refundId),
            seatId: null,
          },
    cancellation: {
      reason: SeatCancelReason.DATE_CANCELLED,
      refundId: left === null ? null : refundId,
      seats:
        left === null
          ? seats.map(({ id }) => ({ seatId: id, refundAmount: null }))
          : sharedOver(seats, left).map(([{ id }, share]) => ({ seatId: id, refundAmount: share })),
    },
  };
}

export type InterruptedDateSettlement =
  | {
      readonly kind: 'credit_owed';
      readonly credit: CreditIssue;
      readonly crediting: SeatCrediting;
    }
  /** Its seats left as they are. */
  | {
      readonly kind: 'nothing_owed';
      readonly because: 'no_active_seat' | 'nothing_left' | 'no_account';
    };

/**
 * An interrupted date's order: one credit note for what is left of its money, on the order's
 *   channel (D-017), its active seats credited with their shares of it. An order with no account
 *   is left, since a credit is the account's.
 */
export function interruptedDateSettlementOf(
  order: SeatOrder,
  creditId: string,
): InterruptedDateSettlement {
  const seats = activeSeatsOf(order);
  if (seats.length === 0) return { kind: 'nothing_owed', because: 'no_active_seat' };
  const left = moneyLeftOf(order);
  if (left === null) return { kind: 'nothing_owed', because: 'nothing_left' };
  const { id: orderId, accountId, channelId, dateId } = order.snapshot;
  if (accountId === null) return { kind: 'nothing_owed', because: 'no_account' };
  const amount = creditAmountFor(left);
  return {
    kind: 'credit_owed',
    credit: {
      id: creditId,
      accountId,
      channelId,
      orderId,
      amount,
      origin: CreditOrigin.INTERRUPTED_DATE,
      originRef: dateId,
    },
    crediting: {
      creditId,
      seats: sharedOver(seats, amount).map(([{ id }, share]) => ({
        seatId: id,
        creditAmount: share,
      })),
    },
  };
}
