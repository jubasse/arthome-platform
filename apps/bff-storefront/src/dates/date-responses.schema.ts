import { z } from 'zod';

import { ArtistSummarySchema, DateCardSchema, DateDetailSchema } from '@arthome/contracts/catalog';
import { StorefrontEnvelopeMetaSchema } from '@arthome/contracts/envelope';

export const DateDetailResponseSchema = StorefrontEnvelopeMetaSchema.extend({
  data: DateDetailSchema,
});

/**
 * `resolvePublicLink`'s `data`, hand-copied from `storefront.yaml` like every path-level shape
 *   (D-058). `kind` is read as a string: an output vocabulary is kept raw, never refused.
 */
export const ResolveResponseSchema = StorefrontEnvelopeMetaSchema.extend({
  data: z.looseObject({
    kind: z.string(),
    id: z.string(),
    canonicalUrl: z.string(),
    date: DateCardSchema.optional(),
    artist: ArtistSummarySchema.optional(),
  }),
});
