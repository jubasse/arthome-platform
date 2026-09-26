import { z } from 'zod';

import { FacetSchema, ShowGroupSchema } from '@arthome/contracts/catalog';
import { StorefrontEnvelopeMetaSchema } from '@arthome/contracts/envelope';
import { StorefrontCursorPageInfoSchema } from '@arthome/contracts/pagination';

/** `/v1/search`'s 200 body, composed from the published schemas as `storefront.yaml` does. */
export const SearchResponseSchema = StorefrontEnvelopeMetaSchema.extend({
  groups: z.array(ShowGroupSchema).optional(),
  facets: z.array(FacetSchema),
  page: StorefrontCursorPageInfoSchema,
});
export type SearchResponse = z.output<typeof SearchResponseSchema>;
