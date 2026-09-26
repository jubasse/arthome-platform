import { z } from 'zod';

/** `resolvePublicLink`'s parameters as `storefront.yaml` declares them (D-058: no zod source). */
const LINK_KINDS = ['date', 'show', 'artist', 'category'] as const;

export const ResolveQuerySchema = z
  .object({
    url: z.url().optional(),
    kind: z.enum(LINK_KINDS).optional(),
    slug: z.string().min(1).optional(),
  })
  .catchall(z.custom(() => false));
export type ResolveQuery = z.infer<typeof ResolveQuerySchema>;
