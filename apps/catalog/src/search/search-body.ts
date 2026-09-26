import type { DateDocument } from '@arthome-platform/search-index';
import type { API, Types } from '@opensearch-project/opensearch';

import { DomainConstant, PublicationState, type Instant } from '@arthome/core';

import { MAX_RESULT_WINDOW } from './search-cursor.js';
import { SearchSort, SearchTab, type SearchQuery } from './search-query.schema.js';

type Query = Types.Common_QueryDsl.QueryContainer;
type Field = keyof DateDocument;

/** The facet ids served, each counted in shows over the field it reads. */
export const FACET_FIELDS = {
  category: 'category_id',
  genre: 'genre_ids',
  tag: 'tag_ids',
  languageDependency: 'language_dependency',
  replayPolicy: 'replay_policy',
  country: 'venue_country',
} as const satisfies Record<string, Field>;
export type FacetId = keyof typeof FACET_FIELDS;

const FACET_VALUES_MAX = 50;

export const MATCHING_DATES = 'matching_dates';
export const SHOW_COUNT = 'shows';

/**
 * What a public card needs and a document can lack: the show's fields arrive on another
 *   topic, and a member the producer sent that this build does not know is stored as null.
 */
const CARD_FIELDS: readonly Field[] = [
  'category_id',
  'publication_state',
  'replay_policy',
  'rights_scope',
];

function terms(field: Field, values: readonly string[] | undefined): Query[] {
  return values === undefined || values.length === 0 ? [] : [{ terms: { [field]: [...values] } }];
}

function tabFilter(tab: SearchTab, now: Instant): Query[] {
  switch (tab) {
    case SearchTab.BEST:
      return [];
    case SearchTab.LIVES:
      return [{ range: { ends_at: { gt: now } } }];
    case SearchTab.REPLAYS:
      return [{ range: { ends_at: { lte: now } } }];
  }
}

function startsWithin(query: SearchQuery): Query[] {
  const { startsAfter, startsBefore } = query;
  if (startsAfter === undefined && startsBefore === undefined) return [];
  return [
    {
      range: {
        starts_at: {
          ...(startsAfter !== undefined && { gte: startsAfter }),
          ...(startsBefore !== undefined && { lt: startsBefore }),
        },
      },
    },
  ];
}

/**
 * The "this weekend" filter and the others apply to DATES, before grouping (the operation's
 *   description), which is what `collapse` gives: it groups the hits the query kept.
 */
export function filtersOf(query: SearchQuery, now: Instant): Query[] {
  return [
    // Fully over, replay included: `publicDisplayStateOf` would say `ended`, with no instant
    // for `displayStateValidUntil`, which a DateCard requires.
    { range: { over_at: { gt: now } } },
    ...CARD_FIELDS.map((field): Query => ({ exists: { field } })),
    ...tabFilter(query.tab, now),
    ...terms('category_id', query.categoryIds),
    ...terms('genre_ids', query.genreIds),
    ...terms('tag_ids', query.tagIds),
    ...terms('artist_id', query.artistIds),
    ...terms('venue_country', query.countryCodes),
    ...terms('language_dependency', query.languageDependency),
    ...terms('replay_policy', query.replayPolicy),
    ...startsWithin(query),
  ];
}

function sortOf(sort: SearchSort): Types.Common.Sort {
  const soonest: Types.Common.Sort = [
    { starts_at: { order: 'asc' } },
    { date_id: { order: 'asc' } },
  ];
  return sort === SearchSort.SOON ? soonest : [{ _score: { order: 'desc' } }, ...soonest];
}

function facetAggregations(): Record<string, Types.Common_Aggregations.AggregationContainer> {
  return Object.fromEntries(
    Object.entries(FACET_FIELDS).map(([facetId, field]) => [
      facetId,
      {
        terms: { field, size: FACET_VALUES_MAX, order: { [SHOW_COUNT]: 'desc' } },
        aggs: { [SHOW_COUNT]: { cardinality: { field: 'show_id' } } },
      },
    ]),
  );
}

/**
 * One date per show, the first under the current sort, with the number of its dates the
 *   query kept. One more group than the page is asked for, so `hasMore` is known without a
 *   count; never past `MAX_RESULT_WINDOW`, which `offsetOf` keeps the offset under.
 */
export function searchBodyOf(
  query: SearchQuery,
  offset: number,
  now: Instant,
): API.Search_RequestBody {
  const text: Query =
    query.q === undefined
      ? { match_all: {} }
      : { multi_match: { query: query.q, fields: ['title_fr', 'title_en'] } };
  return {
    from: offset,
    size: Math.min(query.limit + 1, MAX_RESULT_WINDOW - offset),
    track_total_hits: false,
    query: {
      bool: {
        must: [text],
        filter: filtersOf(query, now),
        // Not public yet. Unreachable once scheduled, since both passages out are one-way, and
        // kept so a state this build misreads cannot reach a public card.
        must_not: [
          { terms: { publication_state: [PublicationState.DRAFT, PublicationState.RESERVE] } },
        ],
      },
    },
    sort: sortOf(query.sort),
    collapse: { field: 'show_id', inner_hits: { name: MATCHING_DATES, size: 0 } },
    aggs: {
      [SHOW_COUNT]: {
        cardinality: {
          field: 'show_id',
          precision_threshold: DomainConstant.SEARCH_EXACT_TOTAL_LIMIT,
        },
      },
      ...facetAggregations(),
    },
  };
}
