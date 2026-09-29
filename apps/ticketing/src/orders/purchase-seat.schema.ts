import { z } from 'zod';

import { PRICE_TIERS } from '@arthome/core';
import {
  CountryCodeSchema,
  DateIdSchema,
  MoneyIn,
  ProfileIdSchema,
  vocabularyIn,
} from '@arthome/core/schema';

/**
 * The storefront's `purchaseSeat` body (openapi/storefront.yaml), with D-089's
 *   `acknowledgeLateEntry` ahead of the contract (HANDOVER §3). A contribution and a credit are
 *   accepted as null alone: neither has a rule yet, and money is never taken on a field ignored.
 */
export const PurchaseSeatSchema = z.strictObject({
  dateId: DateIdSchema,
  tier: vocabularyIn(PRICE_TIERS),
  quantity: z.int().min(1).max(10),
  expectedTotal: MoneyIn,
  contributionMinor: z.null().optional(),
  applyCreditId: z.null().optional(),
  profileId: ProfileIdSchema.nullable().optional(),
  /** A buyer arriving after the start acknowledges what they missed (D-089); ignored before it. */
  acknowledgeLateEntry: z.boolean().optional(),
  declaredTaxLocation: z
    .strictObject({
      country: CountryCodeSchema,
      subdivision: z.string().min(1).nullable().optional(),
      postalCode: z.string().min(1).nullable().optional(),
    })
    .nullable()
    .optional(),
});

export type PurchaseSeatBody = z.infer<typeof PurchaseSeatSchema>;
