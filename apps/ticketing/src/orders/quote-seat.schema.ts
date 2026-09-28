import { z } from 'zod';

import { PRICE_TIERS } from '@arthome/core';
import { vocabularyIn } from '@arthome/core/schema';

/** The storefront's `quoteSeat` body; a contribution and a credit as `purchaseSeat` takes them. */
export const QuoteSeatSchema = z.strictObject({
  tier: vocabularyIn(PRICE_TIERS),
  quantity: z.int().min(1).max(10),
  contributionMinor: z.null().optional(),
  applyCreditId: z.null().optional(),
});

export type QuoteSeatBody = z.infer<typeof QuoteSeatSchema>;
