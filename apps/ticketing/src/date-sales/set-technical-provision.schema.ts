import { z } from 'zod';

/** The studio's `setTechnicalProvision` (openapi/studio.yaml, D-088). */
export const SetTechnicalProvisionSchema = z.strictObject({
  provisionedCapacity: z.int().min(1),
  expectedVersion: z.int().min(1),
});

export type SetTechnicalProvisionBody = z.infer<typeof SetTechnicalProvisionSchema>;
