import type { Types } from '@opensearch-project/opensearch';

import type { LanguageDependency } from '@arthome/core';

/**
 * The show document, and the mapping that decides what searching one means.
 *
 * ⚠ THE FIELD NAMES ARE `snake_case`, LIKE THE WIRE. A search hit's `_source`
 *   is read by the storefront BFF and by whatever reindexes this later, so it
 *   is a boundary shape, not an internal one. Renaming a field to camelCase
 *   here would make the index disagree with the event that fed it, and the
 *   disagreement is invisible until somebody filters on the name that does not
 *   exist and gets zero hits instead of an error.
 *
 * ⚠ AND THERE IS NO TEXT FIELD, WHICH IS THE FIRST THING TO KNOW ABOUT THIS
 *   INDEX. `ShowPublished` carries no title, no synopsis and no artist name —
 *   only identifiers, vocabularies, durations, languages and renditions. So
 *   what this index supports today is FILTERING AND FACETING, not matching a
 *   query string. Inventing a `title` field the projection can never populate
 *   would be worse than not having one: a `match` query against an
 *   always-absent field returns nothing and looks like a relevance problem
 *   rather than a missing contract field. When the wire gains a title, the
 *   field is ADDED (see `SHOW_INDEX_PROPERTIES`, and §"migration" in
 *   `opensearch-client.ts`) — adding a field to a mapping is allowed, changing
 *   one is not.
 */

/** One image at a size that is actually displayed, as the wire spells it. */
export interface IndexedRendition {
  readonly url: string;
  readonly width_px: number;
  readonly height_px: number;
}

/** The projection of one `catalog.show.published.v1` into the index. */
export interface ShowDocument {
  /**
   * ⚠ ALSO THE DOCUMENT `_id`, and stored again on purpose. `_id` is metadata:
   *   it has no doc values, so it can be neither aggregated nor sorted on. Any
   *   "how many shows per artist" facet needs a real field.
   */
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
  /**
   * When the show became public — the event's `occurred_at`, ISO 8601 UTC.
   *
   * ⚠ NAMED FOR THE FACT, NOT FOR THE EVENT. A document is fed by more than
   *   one event in the end (`catalog.show.updated.v1` is next), and an
   *   `occurred_at` on the document would then mean "whichever event touched it
   *   last" — which is not what a "newest shows" sort is asking for. The day an
   *   update is projected, this field must NOT move.
   */
  readonly published_at: string;
  /**
   * When this projector last wrote the document, ISO 8601 UTC.
   *
   * ⚠ THIS IS THE ONE FIELD THAT IS NOT A PURE FUNCTION OF THE EVENT, so a
   *   replay rewrites a document that differs from the previous one in exactly
   *   this field and nowhere else. That is deliberate: without it, an index
   *   that stopped being fed looks exactly like an index that is up to date,
   *   and the lag is only discoverable by comparing counts against Postgres.
   */
  readonly indexed_at: string;
}

/**
 * The concrete index, and the alias every reader and this writer actually use.
 *
 * ⚠ NOTHING ADDRESSES THE CONCRETE INDEX BUT THE MIGRATION ITSELF. A mapping
 *   change that is not additive — a field's type, an analyzer on an existing
 *   field, the shard count — cannot be applied in place: OpenSearch refuses it,
 *   and the only path is to build `…-v2` and move the alias. If the writer and
 *   the readers named `…-v1`, that swap would need every one of them
 *   redeployed in step; through an alias it is one atomic `_aliases` call.
 *
 * ⚠ NO LEADING DOT. An index whose name starts with `.` is a system index in
 *   OpenSearch and is treated differently by security and by snapshots.
 */
export const SHOW_INDEX_ALIAS = 'arthome-catalog-show';
export const SHOW_INDEX_CONCRETE = `${SHOW_INDEX_ALIAS}-v1`;

/** The normalizer named by every language field below. */
const LOWERCASE_NORMALIZER = 'arthome_lowercase';

/**
 * The settings, and the two numbers in them are decisions rather than defaults.
 *
 * ⚠ ONE SHARD, FOR A RELEVANCE REASON AND NOT A SIZE ONE. Scoring is computed
 *   per shard, so document frequency — the "how rare is this term" half of any
 *   relevance formula — is counted per shard too. On a catalogue this small,
 *   splitting it means two documents with the same content score differently
 *   according to which shard they hashed onto, and the symptom is a result
 *   order that changes when a document is reindexed. Shard count cannot be
 *   changed without a reindex, which is the other reason to get it right once.
 *
 * ⚠ ZERO REPLICAS IS A DEVELOPMENT VALUE AND MUST BE RAISED BEFORE ANY REAL
 *   DEPLOYMENT. `compose.yaml` runs a single OpenSearch node; a replica has
 *   nowhere to be allocated, so it stays unassigned and the cluster stays
 *   YELLOW for ever — which teaches everyone that yellow is normal, and that is
 *   how a genuinely degraded cluster goes unnoticed.
 *
 * ⚠ THE NORMALIZER IS WHAT MAKES A LANGUAGE FILTER WORK AT ALL. A `keyword`
 *   field matches byte for byte, and BCP 47 is case-insensitive: `fr-FR`,
 *   `fr-fr` and `FR-fr` are the same tag and would be three different terms.
 *   A normalizer folds the INDEXED term without touching `_source`, so the
 *   surface still displays the tag as it was authored and still filters on it
 *   reliably. Lower-casing in the projection instead would fix the filter and
 *   destroy the display.
 */
export const SHOW_INDEX_SETTINGS: Types.Indices_Common.IndexSettings = {
  number_of_shards: 1,
  number_of_replicas: 0,
  analysis: {
    normalizer: {
      [LOWERCASE_NORMALIZER]: { type: 'custom', filter: ['lowercase'] },
    },
  },
};

/**
 * The properties, one decision per field.
 *
 * ⚠ EVERY IDENTIFIER AND EVERY VOCABULARY MEMBER IS `keyword`, NEVER `text`.
 *   A `text` field is analysed: `cirque_contemporain` would be split and a
 *   filter for `contemporain` would match it. That is the right behaviour for
 *   prose and a catastrophe for a filter, because it is wrong in the direction
 *   that returns MORE results — nobody reports a bug about extra hits. It is
 *   also `keyword` that carries doc values, which is what a `terms` aggregation
 *   needs, and the facet counts on a search page are `terms` aggregations.
 */
export const SHOW_INDEX_PROPERTIES: Record<string, Types.Common_Mapping.Property> = {
  show_id: { type: 'keyword' },
  channel_id: { type: 'keyword' },
  artist_id: { type: 'keyword' },
  category_id: { type: 'keyword' },

  // Multi-valued and faceted. `eager_global_ordinals` is deliberately NOT set:
  // it moves the cost of building the ordinals from the first aggregation to
  // every refresh, which is a trade worth making on a hot, rarely-written
  // index and not on one a CDC stream writes continuously.
  genre_ids: { type: 'keyword' },
  tag_ids: { type: 'keyword' },

  // Range-filtered ("under an hour"), never matched. `integer` rather than
  // `short`: the wire says uint32, and a mapping that is narrower than the
  // contract rejects a document instead of storing it.
  runtime_min: { type: 'integer' },

  // ⚠ NO `null_value`. An unspecified dependency is genuinely ABSENT, and
  //   substituting a member for it would make those shows answer a filter for
  //   that member — an unknown value quietly becoming a real one, which is the
  //   exact fault critical-rules.md §10 exists to prevent. Absent is queryable:
  //   `must_not: { exists: … }`.
  language_dependency: { type: 'keyword' },

  // ⚠ THE TAG IS INDEXED WHOLE, so a filter must send the whole tag: `fr` does
  //   NOT match `fr-FR`. That is a real limitation and it is named rather than
  //   papered over — the additive fix, the day a "any French show" filter is
  //   actually specified, is a derived `…_primary` field holding the primary
  //   subtag. Deriving it now would be a second field with no reader and no
  //   test, which is how a projection starts disagreeing with itself.
  spoken_languages: { type: 'keyword', normalizer: LOWERCASE_NORMALIZER },
  subtitle_languages: { type: 'keyword', normalizer: LOWERCASE_NORMALIZER },
  surtitle_languages: { type: 'keyword', normalizer: LOWERCASE_NORMALIZER },

  // ⚠ CARRIED, NEVER INDEXED. A result card needs the whole rendition ladder so
  //   the surface can pick its own size — a 4K background decoded for a
  //   thumbnail is the first source of memory pressure on a television. But
  //   nobody has ever searched by image URL, and mapping these as `keyword`
  //   would put one inverted-index term per URL, per rendition, per show, for
  //   no query at all. `enabled: false` stores the object in `_source` and
  //   indexes nothing inside it.
  media: { type: 'object', enabled: false },

  published_at: { type: 'date' },
  indexed_at: { type: 'date' },
};

/**
 * The mapping.
 *
 * ⚠ `dynamic: 'strict'` — A DOCUMENT WITH AN UNMAPPED FIELD IS REFUSED. The
 *   default, `true`, lets the FIRST document carrying a new field decide that
 *   field's type for the lifetime of the index: a `runtime_min` that ever
 *   arrives as a string becomes `text`, and every range query after it returns
 *   nothing, silently and permanently. Strict turns that into a 400 on the
 *   write, which this consumer classifies as permanent and dead-letters, where
 *   somebody sees it. Strictness applies to the SHAPE; a vocabulary member this
 *   build has never seen is still kept and treated as neutral
 *   (critical-rules.md §10) — those are different rules and both hold here.
 */
export const SHOW_INDEX_MAPPING: Types.Common_Mapping.TypeMapping = {
  dynamic: 'strict',
  properties: SHOW_INDEX_PROPERTIES,
};
