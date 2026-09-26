import { describe, expect, it } from 'vitest';

import { StorefrontCursorPageInfoSchema } from '@arthome/contracts/pagination';
import { DomainConstant } from '@arthome/core';

import { offsetOf } from './search-cursor.js';
import { dateDocument } from './search-fixtures.js';
import { searchPageOf, type SearchResponseBody } from './search-page.js';
import { SearchQuerySchema } from './search-query.schema.js';

const NOW = '2026-11-04T18:00:00.000Z';
const NOW_MS = Date.parse(NOW);

function body(hitCount: number, shows: number): SearchResponseBody {
  return {
    hits: {
      hits: Array.from({ length: hitCount }, (_, index) => ({
        _source: dateDocument({
          show_id: `show-${index}`,
          // The second group's representative room opens first.
          starts_at: index === 1 ? '2026-11-04T18:40:00.000Z' : '2026-11-04T19:30:00.000Z',
        }),
        inner_hits: { matching_dates: { hits: { total: { value: index + 1 } } } },
      })),
    },
    aggregations: {
      shows: { value: shows },
      category: { buckets: [{ key: 'theatre', shows: { value: shows } }] },
    },
  };
}

describe('searchPageOf', () => {
  it('serves one group per show with the count of its dates the query kept', () => {
    const query = SearchQuerySchema.parse({ limit: '2' });
    const { page } = searchPageOf(body(3, 7), query, 0, NOW, NOW_MS);

    expect(page.groups.map((group) => [group.showId, group.matchingDatesCount])).toEqual([
      ['show-0', 1],
      ['show-1', 2],
    ]);
    expect(page.facets).toContainEqual({
      facetId: 'category',
      values: [{ id: 'theatre', count: 7 }],
    });
  });

  it('pages forward and back from the extra group, with a total that is exact below the limit', () => {
    const query = SearchQuerySchema.parse({ limit: '2' });
    const { page } = searchPageOf(body(3, 7), query, 2, NOW, NOW_MS).page;

    expect(StorefrontCursorPageInfoSchema.safeParse(page).success).toBe(true);
    expect(page).toMatchObject({ hasMore: true, approximateTotal: 7, totalIsLowerBound: false });
    expect(offsetOf(page.nextCursor ?? undefined, NOW_MS)).toBe(4);
    expect(offsetOf(page.prevCursor ?? undefined, NOW_MS)).toBe(0);
  });

  it('says the total is a lower bound once the shows reach the exact limit', () => {
    const shows = DomainConstant.SEARCH_EXACT_TOTAL_LIMIT + 1;
    const { page } = searchPageOf(body(1, shows), SearchQuerySchema.parse({}), 0, NOW, NOW_MS).page;

    expect(page).toMatchObject({
      hasMore: false,
      nextCursor: null,
      approximateTotal: DomainConstant.SEARCH_EXACT_TOTAL_LIMIT,
      totalIsLowerBound: true,
    });
  });

  it('expires the envelope when its first card changes state', () => {
    const { validUntil } = searchPageOf(body(3, 3), SearchQuerySchema.parse({}), 0, NOW, NOW_MS);

    expect(validUntil).toBe('2026-11-04T18:10:00.000Z');
  });

  it('says why a first page is empty', () => {
    const empty = body(0, 0);
    const reasonFor = (input: Record<string, unknown>) =>
      searchPageOf(empty, SearchQuerySchema.parse(input), 0, NOW, NOW_MS).page.page.emptyReason;

    expect(reasonFor({ q: 'nuits' })).toBe('no_match_for_query');
    expect(reasonFor({ q: 'nuits', genreIds: 'opera' })).toBe('no_match_with_filters');
  });
});
