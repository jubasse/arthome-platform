// Aliased because `@arthome-platform/events` is a flat barrel: a wire enum and core's
// vocabulary share each name, and they are a number and a string.
import {
  DateOutcome as WireDateOutcome,
  PriceTier as WirePriceTier,
  RefundReason as WireRefundReason,
  SeatCancelReason as WireSeatCancelReason,
} from '@arthome-platform/events';

import {
  DATE_OUTCOMES,
  DateOutcome,
  PriceTier,
  RefundReason,
  SeatCancelReason,
} from '@arthome/core';

/**
 * The domain's members → the wire's numbers. `satisfies` points at the domain: a new member in
 * core fails this build, and the proto's `UNSPECIFIED = 0` rightly has no domain member.
 */
export const WIRE_PRICE_TIER = {
  [PriceTier.FULL]: WirePriceTier.FULL,
  [PriceTier.REDUCED]: WirePriceTier.REDUCED,
  [PriceTier.SUPPORT]: WirePriceTier.SUPPORT,
} satisfies Record<PriceTier, WirePriceTier>;

export const WIRE_REFUND_REASON = {
  [RefundReason.VIEWER_REQUEST]: WireRefundReason.VIEWER_REQUEST,
  [RefundReason.DATE_CANCELLED]: WireRefundReason.DATE_CANCELLED,
  [RefundReason.ACCOUNT_DELETION]: WireRefundReason.ACCOUNT_DELETION,
  [RefundReason.GOODWILL]: WireRefundReason.GOODWILL,
  [RefundReason.DUPLICATE]: WireRefundReason.DUPLICATE,
  [RefundReason.DISPUTE]: WireRefundReason.DISPUTE,
  [RefundReason.HOLD_EXPIRED_CAPACITY_LOST]: WireRefundReason.HOLD_EXPIRED_CAPACITY_LOST,
} satisfies Record<RefundReason, WireRefundReason>;

/** `PAYMENT_FAILED` has no domain member: a seat exists only once its order is paid (D-077). */
export const WIRE_SEAT_CANCEL_REASON = {
  [SeatCancelReason.VIEWER_REQUEST]: WireSeatCancelReason.VIEWER_REQUEST,
  [SeatCancelReason.DATE_CANCELLED]: WireSeatCancelReason.DATE_CANCELLED,
  [SeatCancelReason.ACCOUNT_DELETION]: WireSeatCancelReason.ACCOUNT_DELETION,
} satisfies Record<SeatCancelReason, WireSeatCancelReason>;

const WIRE_DATE_OUTCOME = {
  [DateOutcome.POSTPONED]: WireDateOutcome.POSTPONED,
  [DateOutcome.CANCELLED]: WireDateOutcome.CANCELLED,
  [DateOutcome.INTERRUPTED]: WireDateOutcome.INTERRUPTED,
} satisfies Record<DateOutcome, WireDateOutcome>;

/** Null for `UNSPECIFIED` and for a member this build does not know: neutral, never refused. */
export function dateOutcomeOf(wire: WireDateOutcome): DateOutcome | null {
  return DATE_OUTCOMES.find((outcome) => WIRE_DATE_OUTCOME[outcome] === wire) ?? null;
}
