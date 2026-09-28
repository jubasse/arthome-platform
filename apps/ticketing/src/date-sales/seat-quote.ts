import {
  basisPoints,
  priceOfTier,
  quoteSeats,
  zero,
  type Money,
  type OrderQuote,
  type PriceTier,
  type ServiceFeeSchedule,
  type TierPrice,
} from '@arthome/core';

/**
 * No fee schedule is set anywhere yet (the pane serves no `serviceFeePerSeat` either), so a seat is
 *   sold with no service fee until one is (HANDOVER §3).
 */
function interimServiceFeeSchedule(currencyCode: string): ServiceFeeSchedule {
  return { perSeat: zero(currencyCode), rateBps: basisPoints(0) };
}

export interface SeatQuote extends OrderQuote {
  readonly unitPrice: Money;
}

/**
 * core's `quoteSeats` over the date's own price for the tier: null while that tier is not on sale.
 *   No promotion is stored and no subscription is known before tokens are verified, so neither
 *   discounts it yet; `quoteSeats` refuses a quantity it cannot sell, `order.quantity_invalid`.
 */
export function seatQuoteOf(
  tiers: readonly TierPrice[],
  tier: PriceTier,
  quantity: number,
): SeatQuote | null {
  const unitPrice = priceOfTier(tiers, tier);
  if (unitPrice === null) return null;
  const quote = quoteSeats(
    unitPrice,
    quantity,
    basisPoints(0),
    null,
    interimServiceFeeSchedule(unitPrice.currencyCode),
  );
  return { ...quote, unitPrice };
}
