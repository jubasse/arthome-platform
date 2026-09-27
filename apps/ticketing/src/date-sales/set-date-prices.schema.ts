import { z } from 'zod';

import { PRICE_TIERS } from '@arthome/core';
import { CurrencyCodeSchema, vocabularyIn } from '@arthome/core/schema';

const TierSchema = z.strictObject({
  tier: vocabularyIn(PRICE_TIERS),
  amountMinor: z.int().min(0),
  currencyCode: CurrencyCodeSchema,
  active: z.boolean(),
});

/**
 * The studio's `setDatePrices` (openapi/studio.yaml). Each tier once, and one currency for the
 *   whole sale: core's headline price compares amounts across tiers and assumes it.
 */
export const SetDatePricesSchema = z.strictObject({
  expectedVersion: z.int().min(1),
  tiers: z
    .array(TierSchema)
    .refine((tiers) => new Set(tiers.map(({ tier }) => tier)).size === tiers.length)
    .refine((tiers) => new Set(tiers.map(({ currencyCode }) => currencyCode)).size <= 1),
});

export type SetDatePricesBody = z.infer<typeof SetDatePricesSchema>;
