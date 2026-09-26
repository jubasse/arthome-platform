import { z } from 'zod';

/** `resolvePublicLink`'s kinds this service resolves; `show`, `artist` and `category` wait for their slugs. */
export const LinkKind = { DATE: 'date' } as const;

/** Unknown parameters refused by name, as on the search. */
export const ResolveQuerySchema = z
  .object({
    url: z.string().min(1).optional(),
    kind: z.enum([LinkKind.DATE]).optional(),
    slug: z.string().min(1).optional(),
  })
  .catchall(z.custom(() => false));
export type ResolveQuery = z.infer<typeof ResolveQuerySchema>;
