import { schemaInvalidRefusal } from '@arthome-platform/http-edge';
import { describe, expect, it } from 'vitest';

import { LanguageDependency } from '@arthome/core';

import { SearchQuerySchema, SearchSort, SearchTab } from './search-query.schema.js';

async function issuesOf(query: Record<string, unknown>) {
  const result = await SearchQuerySchema['~standard'].validate(query);
  return 'issues' in result && result.issues !== undefined ? result.issues : [];
}

describe('SearchQuerySchema', () => {
  it('defaults the tab, the sort and the page size', () => {
    expect(SearchQuerySchema.parse({ q: 'nuit' })).toMatchObject({
      tab: SearchTab.BEST,
      sort: SearchSort.RELEVANCE,
      limit: 20,
    });
  });

  it('reads a lone query-string value and a repeated one as the same list', () => {
    const lone = SearchQuerySchema.parse({ genreIds: 'dance', limit: '12' });
    const repeated = SearchQuerySchema.parse({
      genreIds: ['dance', 'opera'],
      languageDependency: LanguageDependency.NONE,
    });

    expect(lone).toMatchObject({ genreIds: ['dance'], limit: 12 });
    expect(repeated).toMatchObject({
      genreIds: ['dance', 'opera'],
      languageDependency: [LanguageDependency.NONE],
    });
  });

  it('names every criterion, tab and sort it does not serve, rather than ignoring them', async () => {
    const issues = await issuesOf({
      q: 'nuit',
      tab: 'artists',
      sort: 'popularity',
      priceMaxMinor: '2000',
      cityIds: 'paris',
    });

    expect(schemaInvalidRefusal(issues).params).toEqual({
      fields: ['cityIds', 'priceMaxMinor', 'sort', 'tab'],
    });
  });

  it('refuses a one-letter query, which the contract bounds at two', () => {
    expect(SearchQuerySchema.safeParse({ q: 'n' }).success).toBe(false);
  });
});
