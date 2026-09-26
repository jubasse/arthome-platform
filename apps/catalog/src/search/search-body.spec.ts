import { describe, expect, it } from 'vitest';

import { ReplayPolicy } from '@arthome/core';

import { filtersOf, searchBodyOf } from './search-body.js';
import { MAX_RESULT_WINDOW } from './search-cursor.js';
import { SearchQuerySchema, SearchTab } from './search-query.schema.js';

const NOW = '2026-11-04T20:00:00.000Z';
const query = (input: Record<string, unknown>) => SearchQuerySchema.parse(input);

describe('searchBodyOf', () => {
  it('keeps only dates not yet over, whose card has every field it requires', () => {
    expect(filtersOf(query({}), NOW)).toEqual([
      { range: { over_at: { gt: NOW } } },
      { exists: { field: 'category_id' } },
      { exists: { field: 'publication_state' } },
      { exists: { field: 'replay_policy' } },
      { exists: { field: 'rights_scope' } },
    ]);
  });

  it('splits lives from replays at the end of the live show', () => {
    expect(filtersOf(query({ tab: SearchTab.LIVES }), NOW)).toContainEqual({
      range: { ends_at: { gt: NOW } },
    });
    expect(filtersOf(query({ tab: SearchTab.REPLAYS }), NOW)).toContainEqual({
      range: { ends_at: { lte: NOW } },
    });
  });

  it('applies each criterion to the field the index holds it in', () => {
    const filters = filtersOf(
      query({
        countryCodes: 'FR',
        replayPolicy: ReplayPolicy.INCLUDED,
        startsAfter: '2026-11-06T00:00:00.000Z',
      }),
      NOW,
    );

    expect(filters).toContainEqual({ terms: { venue_country: ['FR'] } });
    expect(filters).toContainEqual({ terms: { replay_policy: [ReplayPolicy.INCLUDED] } });
    expect(filters).toContainEqual({
      range: { starts_at: { gte: '2026-11-06T00:00:00.000Z' } },
    });
  });

  it('asks for one group more than the page, and never past the window the index can page', () => {
    expect(searchBodyOf(query({ limit: '12' }), 24, NOW)).toMatchObject({ from: 24, size: 13 });
    expect(searchBodyOf(query({ limit: '12' }), MAX_RESULT_WINDOW - 5, NOW)).toMatchObject({
      size: 5,
    });
  });

  it('matches the title in both languages, and every date without a query', () => {
    expect(searchBodyOf(query({ q: 'nuits' }), 0, NOW).query).toMatchObject({
      bool: { must: [{ multi_match: { query: 'nuits', fields: ['title_fr', 'title_en'] } }] },
    });
    expect(searchBodyOf(query({}), 0, NOW).query).toMatchObject({
      bool: { must: [{ match_all: {} }] },
    });
  });
});
