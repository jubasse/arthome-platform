import type { z } from 'zod';

import type { PriceTierSchema } from '@arthome/contracts/catalog';
import type { Instant } from '@arthome/core';

import { availabilityFiguresOf } from '../date-sales/date-sales-figures.js';
import type { DateSalesRow } from '../date-sales/date-sales.entity.js';

/**
 * How long the figures served hold, from `servedAt`. data-model.md §3.1 and storefront.yaml's
 *   `refreshDateAvailability` own the number; core carries no constant for it yet.
 */
export const AVAILABILITY_VALID_SECONDS = 60;

/**
 * storefront.yaml's `refreshDateAvailability` body, public: the same for every caller, with no
 *   per-viewer overlay. `serviceFeePerSeat` is absent: no fee schedule is set anywhere yet.
 */
export interface DateAvailability {
  readonly seatsAvailable: number;
  readonly waitlistCount: number;
  readonly fillRateBps: number;
  readonly soldOut: boolean;
  readonly priceTiers: readonly z.output<typeof PriceTierSchema>[];
}

export function dateAvailabilityOf(row: DateSalesRow): DateAvailability {
  const { seatsAvailable, waitlistCount, fillRateBps, soldOut } = availabilityFiguresOf(row);
  return {
    seatsAvailable,
    waitlistCount,
    fillRateBps,
    soldOut,
    priceTiers: row.price_tiers.map(({ tier, amountMinor, currencyCode, active }) => ({
      tier,
      amount: { amountMinor, currencyCode },
      active,
    })),
  };
}

export function availabilityValidUntil(servedAt: Instant): Instant {
  return new Date(Date.parse(servedAt) + AVAILABILITY_VALID_SECONDS * 1_000).toISOString();
}
