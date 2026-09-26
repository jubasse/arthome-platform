import type { Types } from '@opensearch-project/opensearch';

import type {
  LanguageDependency,
  PublicationState,
  ReplayPolicy,
  RightsScope,
} from '@arthome/core';

import { LOWERCASE_NORMALIZER } from './settings.js';
import type { IndexedRendition } from './show-document.js';
import type { DateProjection, ScheduledDateFields } from '../consumer/date-projection.entity.js';
import type { ShowProjection } from '../consumer/show-projection.entity.js';

/**
 * One document per public date, what a search result card is built from: the date's own
 * facts, and its show's, copied in. The show's fields are `null` until the show is known here;
 * the document is recomposed when it is.
 */
export interface DateDocument {
  readonly date_id: string;
  readonly show_id: string;
  readonly channel_id: string;
  readonly venue_id: string;
  readonly starts_at: string;
  readonly venue_timezone: string;
  readonly venue_city: string;
  readonly venue_country: string;
  readonly runtime_min: number;
  readonly replay_policy: ReplayPolicy | null;
  readonly replay_window_hours: number;
  readonly rights_scope: RightsScope | null;
  readonly blackout_countries: readonly string[];
  readonly canonical_url: string;
  readonly publication_state: PublicationState | null;

  readonly artist_id: string | null;
  readonly category_id: string | null;
  readonly genre_ids: readonly string[];
  readonly tag_ids: readonly string[];
  readonly language_dependency: LanguageDependency | null;
  readonly title_fr: string;
  readonly title_en: string;
  readonly media: {
    readonly wide: readonly IndexedRendition[];
    readonly poster: readonly IndexedRendition[];
  };

  readonly indexed_at: string;
}

/** Readers and this writer name the alias only, as for the show index. */
export const DATE_INDEX_ALIAS = 'arthome-catalog-date';
export const DATE_INDEX_CONCRETE = `${DATE_INDEX_ALIAS}-v1`;

export const DATE_INDEX_PROPERTIES: Record<string, Types.Common_Mapping.Property> = {
  date_id: { type: 'keyword' },
  show_id: { type: 'keyword' },
  channel_id: { type: 'keyword' },
  venue_id: { type: 'keyword' },
  starts_at: { type: 'date' },
  venue_timezone: { type: 'keyword' },
  venue_city: { type: 'keyword', normalizer: LOWERCASE_NORMALIZER },
  venue_country: { type: 'keyword' },
  runtime_min: { type: 'integer' },
  replay_policy: { type: 'keyword' },
  replay_window_hours: { type: 'integer' },
  rights_scope: { type: 'keyword' },
  blackout_countries: { type: 'keyword' },
  /** Served, never searched. */
  canonical_url: { type: 'keyword', index: false, doc_values: false },
  publication_state: { type: 'keyword' },

  artist_id: { type: 'keyword' },
  category_id: { type: 'keyword' },
  genre_ids: { type: 'keyword' },
  tag_ids: { type: 'keyword' },
  language_dependency: { type: 'keyword' },
  title_fr: { type: 'text', analyzer: 'french' },
  title_en: { type: 'text', analyzer: 'english' },
  media: { type: 'object', enabled: false },

  indexed_at: { type: 'date' },
};

export const DATE_INDEX_MAPPING: Types.Common_Mapping.TypeMapping = {
  dynamic: 'strict',
  properties: DATE_INDEX_PROPERTIES,
};

export function dateDocumentOf(
  date: DateProjection & { readonly scheduled: ScheduledDateFields },
  show: ShowProjection | null,
  indexedAt: Date,
): DateDocument {
  const { scheduled } = date;
  const updatable = show?.updatable ?? null;
  return {
    date_id: date.date_id,
    show_id: scheduled.show_id,
    channel_id: scheduled.channel_id,
    venue_id: scheduled.venue_id,
    starts_at: scheduled.starts_at,
    venue_timezone: scheduled.venue_timezone,
    venue_city: scheduled.venue_city,
    venue_country: scheduled.venue_country,
    runtime_min: scheduled.runtime_min,
    replay_policy: scheduled.replay_policy,
    replay_window_hours: scheduled.replay_window_hours,
    rights_scope: scheduled.rights_scope,
    blackout_countries: scheduled.blackout_countries,
    canonical_url: scheduled.canonical_url,
    publication_state: date.publication_state,

    artist_id: show?.published?.artist_id ?? null,
    category_id: show?.published?.category_id ?? null,
    genre_ids: updatable?.genre_ids ?? [],
    tag_ids: updatable?.tag_ids ?? [],
    language_dependency: updatable?.language_dependency ?? null,
    title_fr: updatable?.title.fr ?? '',
    title_en: updatable?.title.en ?? '',
    media: updatable?.media ?? { wide: [], poster: [] },

    indexed_at: indexedAt.toISOString(),
  };
}
