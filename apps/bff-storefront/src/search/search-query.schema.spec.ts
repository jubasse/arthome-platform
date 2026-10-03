import { schemaInvalidRefusal } from '@arthome-platform/http-edge';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SearchCriteriaSchema } from '@arthome/contracts/catalog';
import { querySchemaOf } from '@arthome/contracts/http';
import { storefrontApi } from '@arthome/contracts/storefront-api';

import { searchParamsOf } from '../query-string.js';

const { search } = storefrontApi.routes;
const SearchQuerySchema = querySchemaOf(search);

const routeParameterNames = new Set<string>(search.parameters.map((parameter) => parameter.name));

const CRITERIA_SHAPE: Readonly<Record<string, z.ZodType>> = Object.fromEntries(
  Object.entries(SearchQuerySchema instanceof z.ZodObject ? SearchQuerySchema.shape : {}).filter(
    ([name]) => !routeParameterNames.has(name),
  ),
);

describe('the storefront search query', () => {
  it('reads every criterion the contract publishes, so a new one fails here first', () => {
    expect(Object.keys(CRITERIA_SHAPE).sort()).toEqual(
      Object.keys(SearchCriteriaSchema.shape).sort(),
    );
  });

  it('turns query-string values into the contract’s types', () => {
    expect(
      SearchQuerySchema.parse({
        genreIds: 'dance',
        cityIds: ['paris', 'lyon'],
        priceMaxMinor: '2000',
        onPromotion: 'true',
        limit: '12',
      }),
    ).toEqual({
      genreIds: ['dance'],
      cityIds: ['paris', 'lyon'],
      priceMaxMinor: 2000,
      onPromotion: true,
      limit: 12,
    });
  });

  it('names an unknown parameter and a value outside the contract', async () => {
    const result = await SearchQuerySchema['~standard'].validate({ tab: 'concerts', page: '2' });
    const issues = 'issues' in result && result.issues !== undefined ? result.issues : [];

    expect(schemaInvalidRefusal(issues).params).toEqual({ fields: ['page', 'tab'] });
  });

  it('writes lists back as repeated keys, and leaves out what was not sent', () => {
    const query = SearchQuerySchema.parse({ q: 'nuits', genreIds: ['dance', 'opera'] });

    expect(searchParamsOf(query).toString()).toBe('q=nuits&genreIds=dance&genreIds=opera');
  });
});
