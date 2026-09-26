import { z } from 'zod';

/**
 * The studio's `updateChannelIdentity` (openapi/studio.yaml). `avatarAssetId` is accepted only as
 *   null: no asset service exists to read one, and a value ignored in silence would look saved.
 */
export const UpdateIdentitySchema = z.strictObject({
  expectedVersion: z.int().min(0),
  publicName: z.string().trim().min(1).max(120).optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9-]{3,80}$/)
    .optional(),
  biography: z
    .array(z.strictObject({ contentLanguage: z.string().min(1), text: z.string().max(4000) }))
    .optional(),
  categoryId: z.string().min(1).optional(),
  avatarAssetId: z.null().optional(),
});

export type UpdateIdentityBody = z.infer<typeof UpdateIdentitySchema>;
