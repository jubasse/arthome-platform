import type { z } from 'zod';

import {
  SearchCriteriaSchema,
  type FacetSchema,
  type ShowGroupSchema,
} from '@arthome/contracts/catalog';
import type { EMPTY_REASONS, StorefrontCursorPageInfoSchema } from '@arthome/contracts/pagination';
import { DomainConstant, type Instant } from '@arthome/core';

import { dateCardOf, type ServableDateDocument } from './date-card.js';
import { FACET_FIELDS, MATCHING_DATES, SHOW_COUNT } from './search-body.js';
import { cursorAt } from './search-cursor.js';
import type { SearchQuery } from './search-query.schema.js';

export type ShowGroup = z.output<typeof ShowGroupSchema>;
export type Facet = z.output<typeof FacetSchema>;
export type PageInfo = z.output<typeof StorefrontCursorPageInfoSchema>;
type EmptyReason = (typeof EMPTY_REASONS)[number];

export interface SearchPage {
  readonly groups: readonly ShowGroup[];
  readonly facets: readonly Facet[];
  readonly page: PageInfo;
}

/** The slice of OpenSearch's response this reads; the client types `_source` as `any`. */
export interface SearchResponseBody {
  readonly hits: {
    readonly hits: readonly {
      readonly _source: ServableDateDocument;
      readonly inner_hits: Record<string, { readonly hits: { readonly total: { value: number } } }>;
    }[];
  };
  readonly aggregations: Record<
    string,
    {
      readonly value?: number;
      readonly buckets?: readonly {
        readonly key: string;
        readonly [SHOW_COUNT]: { readonly value: number };
      }[];
    }
  >;
}

const NO_MATCH_FOR_QUERY: EmptyReason = 'no_match_for_query';
const NO_MATCH_WITH_FILTERS: EmptyReason = 'no_match_with_filters';

function filtered(query: SearchQuery): boolean {
  return Object.keys(SearchCriteriaSchema.shape).some((key) => query[key] !== undefined);
}

function facetsOf(aggregations: SearchResponseBody['aggregations']): Facet[] {
  return Object.keys(FACET_FIELDS).map((facetId) => ({
    facetId,
    values: (aggregations[facetId]?.buckets ?? []).map((bucket) => ({
      id: bucket.key,
      count: bucket[SHOW_COUNT].value,
    })),
  }));
}

function earliest(instants: readonly Instant[]): Instant | null {
  return instants.reduce<Instant | null>(
    (soonest, instant) =>
      soonest === null || Date.parse(instant) < Date.parse(soonest) ? instant : soonest,
    null,
  );
}

/**
 * The page and the instant its first perishable value expires: the envelope's `validUntil`,
 *   past which a surface re-runs the display rule on what it holds.
 */
export function searchPageOf(
  body: SearchResponseBody,
  query: SearchQuery,
  offset: number,
  now: Instant,
  nowMs: number,
): { readonly page: SearchPage; readonly validUntil: Instant | null } {
  const hits = body.hits.hits.slice(0, query.limit);
  const groups = hits.map((hit): ShowGroup => {
    const representativeDate = dateCardOf(hit._source, now);
    return {
      showId: hit._source.show_id,
      title: representativeDate.title,
      representativeDate,
      matchingDatesCount: hit.inner_hits[MATCHING_DATES]?.hits.total.value ?? 1,
    };
  });

  const shows = body.aggregations[SHOW_COUNT]?.value ?? 0;
  const limit = DomainConstant.SEARCH_EXACT_TOTAL_LIMIT;
  const hasMore = body.hits.hits.length > query.limit;
  const page: PageInfo = {
    hasMore,
    nextCursor: hasMore ? cursorAt(offset + query.limit, nowMs) : null,
    prevCursor: offset > 0 ? cursorAt(Math.max(0, offset - query.limit), nowMs) : null,
    approximateTotal: Math.min(shows, limit),
    totalIsLowerBound: shows >= limit,
    ...(groups.length === 0 &&
      offset === 0 && {
        emptyReason: filtered(query) ? NO_MATCH_WITH_FILTERS : NO_MATCH_FOR_QUERY,
      }),
  };

  return {
    page: { groups, facets: facetsOf(body.aggregations), page },
    validUntil: earliest(groups.map((group) => group.representativeDate.displayStateValidUntil)),
  };
}
