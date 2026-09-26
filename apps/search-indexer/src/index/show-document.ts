import type { Types } from '@opensearch-project/opensearch';

import type { LanguageDependency } from '@arthome/core';

import { LOWERCASE_NORMALIZER } from './settings.js';
import type { ShowProjection } from '../consumer/show-projection.entity.js';

/**
 * The field names are `snake_case` like the wire. `_source` is read by the storefront BFF
 *   and by whatever reindexes this, so renaming one here makes the index disagree with the
 *   event that fed it — invisibly, until a filter returns zero hits instead of an error.
 */

export interface IndexedRendition {
  readonly url: string;
  readonly width_px: number;
  readonly height_px: number;
}

export interface ShowDocument {
  /** Also the document `_id`, stored again: `_id` has no doc values, so nothing can aggregate or sort on it. */
  readonly show_id: string;
  readonly channel_id: string;
  readonly artist_id: string;
  readonly category_id: string;
  readonly genre_ids: readonly string[];
  readonly tag_ids: readonly string[];
  readonly runtime_min: number;
  /** `null` when the producer sent a member this build does not know. */
  readonly language_dependency: LanguageDependency | null;
  readonly spoken_languages: readonly string[];
  readonly subtitle_languages: readonly string[];
  readonly surtitle_languages: readonly string[];
  readonly media: {
    readonly wide: readonly IndexedRendition[];
    readonly poster: readonly IndexedRendition[];
  };
  /** Empty when the show has no copy in that language. */
  readonly title_fr: string;
  readonly title_en: string;
  readonly synopsis_fr: string;
  readonly synopsis_en: string;
  /**
   * The event's `occurred_at`. Named for the fact, not the event: once a second event feeds
   * this document, a "newest shows" sort still means publication, so this must not move.
   */
  readonly published_at: string;
  /**
   * The only field that is not a pure function of the event, so a replay rewrites the
   * document. Deliberate: without it, an index that stopped being fed looks up to date.
   */
  readonly indexed_at: string;
}

/**
 * Readers and this writer address the alias only. A non-additive mapping change cannot be
 *   applied in place: the path is to build `…-v2` and move the alias in one `_aliases` call,
 *   which naming `…-v1` anywhere else would turn into a lockstep redeploy.
 */
export const SHOW_INDEX_ALIAS = 'arthome-catalog-show';
export const SHOW_INDEX_CONCRETE = `${SHOW_INDEX_ALIAS}-v1`;

/**
 * Every identifier and vocabulary member is `keyword`, never `text`: `text` is analysed, so a
 *   filter for `contemporain` would match `cirque_contemporain` — wrong in the direction that
 *   returns MORE results. `keyword` also carries the doc values a `terms` facet needs.
 */
export const SHOW_INDEX_PROPERTIES: Record<string, Types.Common_Mapping.Property> = {
  show_id: { type: 'keyword' },
  channel_id: { type: 'keyword' },
  artist_id: { type: 'keyword' },
  category_id: { type: 'keyword' },

  genre_ids: { type: 'keyword' },
  tag_ids: { type: 'keyword' },

  /** `integer` rather than `short`: the wire says uint32, and a mapping narrower than the contract rejects the document. */
  runtime_min: { type: 'integer' },

  /**
   * No `null_value`: substituting a member would make unspecified shows answer a filter for
   *   it (critical-rules.md §10). Absent is queryable — `must_not: { exists: … }`.
   */
  language_dependency: { type: 'keyword' },

  /**
   * The tag is indexed whole: `fr` does not match `fr-FR`. The additive fix, once such a
   *   filter is specified, is a derived `…_primary` field.
   */
  spoken_languages: { type: 'keyword', normalizer: LOWERCASE_NORMALIZER },
  subtitle_languages: { type: 'keyword', normalizer: LOWERCASE_NORMALIZER },
  surtitle_languages: { type: 'keyword', normalizer: LOWERCASE_NORMALIZER },

  /**
   * The whole ladder is carried so the surface picks its size — a 4K background decoded for a
   * thumbnail is the first memory pressure on a television. Nothing searches by image URL.
   */
  media: { type: 'object', enabled: false },

  /** One field per language, each with its own stemming: `nuits` must find `nuit`. */
  title_fr: { type: 'text', analyzer: 'french' },
  title_en: { type: 'text', analyzer: 'english' },
  synopsis_fr: { type: 'text', analyzer: 'french' },
  synopsis_en: { type: 'text', analyzer: 'english' },

  published_at: { type: 'date' },
  indexed_at: { type: 'date' },
};

/**
 * `dynamic: 'strict'` refuses an unmapped field. The default lets the FIRST document carrying
 *   a new field fix its type for the life of the index: a `runtime_min` arriving as a string
 *   becomes `text`, and every range query after it silently returns nothing.
 */
export const SHOW_INDEX_MAPPING: Types.Common_Mapping.TypeMapping = {
  dynamic: 'strict',
  properties: SHOW_INDEX_PROPERTIES,
};

/** The show's document once ShowPublished has landed; an update alone cannot make one. */
export function showDocumentOf(show: ShowProjection, indexedAt: Date): ShowDocument | null {
  const { published, updatable } = show;
  if (published === null || updatable === null) return null;
  return {
    show_id: show.show_id,
    channel_id: published.channel_id,
    artist_id: published.artist_id,
    category_id: published.category_id,
    genre_ids: updatable.genre_ids,
    tag_ids: updatable.tag_ids,
    runtime_min: published.runtime_min,
    language_dependency: updatable.language_dependency,
    spoken_languages: published.spoken_languages,
    subtitle_languages: published.subtitle_languages,
    surtitle_languages: published.surtitle_languages,
    media: updatable.media,
    title_fr: updatable.title.fr,
    title_en: updatable.title.en,
    synopsis_fr: updatable.synopsis.fr,
    synopsis_en: updatable.synopsis.en,
    published_at: published.published_at,
    indexed_at: indexedAt.toISOString(),
  };
}
