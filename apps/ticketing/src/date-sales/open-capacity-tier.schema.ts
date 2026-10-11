import { z } from 'zod';

/** The studio's `openCapacityTier` (openapi/studio.yaml). */
export const OpenCapacityTierSchema = z.strictObject({
  additionalCapacity: z.int().min(1),
  expectedVersion: z.int().min(1),
  /** False puts the tier on public sale at once, notifying nobody (D-094). */
  notifyWaitlist: z.boolean().default(true),
});

export type OpenCapacityTierBody = z.infer<typeof OpenCapacityTierSchema>;
