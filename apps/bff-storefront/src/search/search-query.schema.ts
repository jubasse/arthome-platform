import { z } from 'zod';

import { SearchCriteriaSchema } from '@arthome/contracts/catalog';
import { PageCursorSchema } from '@arthome/core/schema';

/**
 * `/v1/search`'s query parameters as `storefront.yaml` declares them. Hand-copied: D-058 leaves
 *   `paths` without a zod source, so this is the one place a surface's search query is checked
 *   against the contract before a service sees it. The criteria come from `SearchCriteriaSchema`.
 */
const SEARCH_TABS = ['best', 'lives', 'replays', 'artists'] as const;
const SEARCH_SORTS = ['relevance', 'soon', 'popularity', 'price_asc', 'price_desc'] as const;

/** A query string gives a lone value as a string and a repeated one as an array. */
function listParam<T extends z.ZodType>(schema: T): z.ZodPreprocess<T> {
  return z.preprocess((value) => (typeof value === 'string' ? [value] : value), schema);
}

function numberParam<T extends z.ZodType>(schema: T): z.ZodPreprocess<T> {
  return z.preprocess(
    (value) => (typeof value === 'string' && value !== '' ? Number(value) : value),
    schema,
  );
}

function booleanParam<T extends z.ZodType>(schema: T): z.ZodPreprocess<T> {
  return z.preprocess(
    (value) => (value === 'true' ? true : value === 'false' ? false : value),
    schema,
  );
}

const criterion = SearchCriteriaSchema.shape;

export const CRITERIA_SHAPE = {
  categoryIds: listParam(criterion.categoryIds),
  genreIds: listParam(criterion.genreIds),
  tagIds: listParam(criterion.tagIds),
  artistIds: listParam(criterion.artistIds),
  cityIds: listParam(criterion.cityIds),
  countryCodes: listParam(criterion.countryCodes),
  languageDependency: listParam(criterion.languageDependency),
  replayPolicy: listParam(criterion.replayPolicy),
  displayStates: listParam(criterion.displayStates),
  priceMinMinor: numberParam(criterion.priceMinMinor),
  priceMaxMinor: numberParam(criterion.priceMaxMinor),
  startsAfter: criterion.startsAfter,
  startsBefore: criterion.startsBefore,
  almostSoldOut: booleanParam(criterion.almostSoldOut),
  onPromotion: booleanParam(criterion.onPromotion),
  accessibility: listParam(criterion.accessibility),
};

/** An unknown parameter is refused by name; `strictObject` would refuse it with an empty path. */
export const SearchQuerySchema = z
  .object({
    q: z.string().min(2).optional(),
    tab: z.enum(SEARCH_TABS).optional(),
    sort: z.enum(SEARCH_SORTS).optional(),
    cursor: PageCursorSchema.optional(),
    limit: numberParam(z.int().min(1).max(50).optional()),
    ...CRITERIA_SHAPE,
  })
  .catchall(z.custom(() => false));
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

/** Back into a query string, repeated keys for lists, for the service behind. */
export function searchParamsOf(query: SearchQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
  }
  return params;
}
