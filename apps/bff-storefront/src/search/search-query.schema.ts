import { z } from 'zod';

import { querySchemaOf, type RouteQuery } from '@arthome/contracts/http';
import { storefrontApi } from '@arthome/contracts/storefront-api';

const { search } = storefrontApi.routes;

/**
 * `/v1/search`'s query as the contract declares it: lists, numbers and booleans decoded from the
 *   query string, the criteria at the top, an unknown parameter refused by name.
 */
export const SearchQuerySchema: z.ZodType<SearchQuery, unknown> = querySchemaOf(search);
export type SearchQuery = RouteQuery<typeof search>;

const routeParameterNames = new Set<string>(search.parameters.map((parameter) => parameter.name));

/** The criteria the query reads, exploded from `filters` rather than listed here. */
export const CRITERIA_SHAPE: Readonly<Record<string, z.ZodType>> = Object.fromEntries(
  Object.entries(SearchQuerySchema instanceof z.ZodObject ? SearchQuerySchema.shape : {}).filter(
    ([name]) => !routeParameterNames.has(name),
  ),
);
