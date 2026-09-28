import { isZero, type Instant, type Money } from '@arthome/core';

import type { SeatQuote } from '../date-sales/seat-quote.js';

/**
 * The storefront contract's `SeatQuote` line kinds that ticketing composes, a vocabulary of that
 *   endpoint alone; `promotion` and `credit_applied` wait for promotions and credits.
 */
const QuoteLineKind = {
  TIER: 'tier',
  SERVICE_FEE: 'service_fee',
  SUBSCRIPTION_DISCOUNT: 'subscription_discount',
} as const;
type QuoteLineKind = (typeof QuoteLineKind)[keyof typeof QuoteLineKind];

export interface SeatQuoteLine {
  readonly kind: QuoteLineKind;
  readonly amount: Money;
}

/** storefront.yaml's `SeatQuote`; no `vatIncluded` while the tax model awaits counsel. */
export interface SeatQuoteView {
  readonly lines: readonly SeatQuoteLine[];
  readonly total: Money;
  readonly validUntil: Instant;
}

/** The addends of the total, a zero one left out: the tier always, a fee or a discount when any. */
export function seatQuoteViewOf(quote: SeatQuote, validUntil: Instant): SeatQuoteView {
  const lines: SeatQuoteLine[] = [{ kind: QuoteLineKind.TIER, amount: quote.tierTotal }];
  if (!isZero(quote.serviceFee)) {
    lines.push({ kind: QuoteLineKind.SERVICE_FEE, amount: quote.serviceFee });
  }
  if (!isZero(quote.discount)) {
    lines.push({
      kind: QuoteLineKind.SUBSCRIPTION_DISCOUNT,
      amount: { ...quote.discount, amountMinor: -quote.discount.amountMinor },
    });
  }
  return { lines, total: quote.total, validUntil };
}
