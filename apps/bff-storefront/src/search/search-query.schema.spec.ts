import { schemaInvalidRefusal } from '@arthome-platform/http-edge';
import { describe, expect, it } from 'vitest';

import { SearchCriteriaSchema } from '@arthome/contracts/catalog';

import { CRITERIA_SHAPE, SearchQuerySchema, searchParamsOf } from './search-query.schema.js';

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
