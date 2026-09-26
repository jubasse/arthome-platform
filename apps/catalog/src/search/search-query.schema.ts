import { z } from 'zod';

import { SearchCriteriaSchema } from '@arthome/contracts/catalog';
import { InstantIn, PageCursorSchema } from '@arthome/core/schema';

/**
 * The tabs and sorts this service answers, a narrowing of `/v1/search`'s: `artists`,
 *   `popularity` and the two price sorts need data the index does not hold yet.
 */
export const SearchTab = { BEST: 'best', LIVES: 'lives', REPLAYS: 'replays' } as const;
export type SearchTab = (typeof SearchTab)[keyof typeof SearchTab];

export const SearchSort = { RELEVANCE: 'relevance', SOON: 'soon' } as const;
export type SearchSort = (typeof SearchSort)[keyof typeof SearchSort];

/** A query string gives a lone value as a string and a repeated one as an array. */
function listParam<T extends z.ZodType>(schema: T): z.ZodPreprocess<T> {
  return z.preprocess((value) => (typeof value === 'string' ? [value] : value), schema);
}

const criterion = SearchCriteriaSchema.shape;

const SEARCH_QUERY_SHAPE = {
  q: z.string().min(2).optional(),
  tab: z.enum([SearchTab.BEST, SearchTab.LIVES, SearchTab.REPLAYS]).default(SearchTab.BEST),
  sort: z.enum([SearchSort.RELEVANCE, SearchSort.SOON]).default(SearchSort.RELEVANCE),
  cursor: PageCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  categoryIds: listParam(criterion.categoryIds),
  genreIds: listParam(criterion.genreIds),
  tagIds: listParam(criterion.tagIds),
  artistIds: listParam(criterion.artistIds),
  countryCodes: listParam(criterion.countryCodes),
  languageDependency: listParam(criterion.languageDependency),
  replayPolicy: listParam(criterion.replayPolicy),
  startsAfter: InstantIn.optional(),
  startsBefore: InstantIn.optional(),
};

/**
 * Every key outside the served shape is refused BY NAME, the contract's other criteria
 *   included: a filter ignored in silence answers another question with a straight face.
 *   `strictObject` and `catchall(z.never())` refuse too, both as one issue with an empty path,
 *   so `fields` would name nothing.
 */
export const SearchQuerySchema = z.object(SEARCH_QUERY_SHAPE).catchall(z.custom(() => false));
export type SearchQuery = z.infer<typeof SearchQuerySchema>;
