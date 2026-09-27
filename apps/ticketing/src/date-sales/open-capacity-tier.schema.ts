import { z } from 'zod';

/** The studio's `openCapacityTier` (openapi/studio.yaml). */
export const OpenCapacityTierSchema = z.strictObject({
  additionalCapacity: z.int().min(1),
  expectedVersion: z.int().min(1),
  /** Accepted as the contract has it; the waiting list and its notification are T5's. */
  notifyWaitlist: z.boolean().default(true),
});

export type OpenCapacityTierBody = z.infer<typeof OpenCapacityTierSchema>;
