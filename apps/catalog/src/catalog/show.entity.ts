import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import type { LanguageDependency, MediaSet } from '@arthome/core';

/**
 * The root aggregate of `catalog` (data-model.md §2.1).
 *
 * ⚠ THIS IS THE SLICE THE `ShowPublished` CONTRACT EXERCISES, NOT THE WHOLE
 *   AGGREGATE. §2.1 also names the bilingual title and synopsis, the cast, and
 *   §2.7 adds the per-language slugs. All four are absent on purpose, and the
 *   reason is the event: `arthome/catalog/v1/events.proto` publishes NONE of
 *   them. A column this slice neither writes nor reads nor emits would be shape
 *   invented ahead of the decision that needs it — the fault identity recorded
 *   against itself when it added `status` and took it back.
 *
 *   The omission is worth more than the columns, so it is recorded rather than
 *   quietly worked around: `ShowPublished` CARRIES NO DISPLAYABLE FIELD. A
 *   consumer of `arthome.catalog.show` — the search index is the first one —
 *   cannot get a title, a synopsis or a slug out of this topic, and will have to
 *   either read across a boundary (forbidden, critical-rules #1) or wait for the
 *   contract to carry them. See HANDOVER.md.
 *
 * ⚠ `version` IS ABSENT, AND THAT IS NOT AN OVERSIGHT. Optimistic concurrency
 *   belongs to `Publication`'s transitions (§2.3), where two operators race over
 *   one state machine and the arbitration is `expectedVersion` + `STATE_CONFLICT`.
 *   Publishing a show here is ONE insert with no prior state to conflict with, so
 *   a version column would be a counter nothing compares. The day
 *   `catalog.publication` is built, it brings its own.
 *
 * ⚠ THE COLUMN IS `category_id`, AND THE DOMAIN DOCUMENT SAYS "discipline".
 *   The wire decides (code-conventions.md §5.2: the wire is what is expensive to
 *   change), and `ShowPublished.category_id` is published and stable. Renaming it
 *   here to match the prose would put a second name on one concept at the exact
 *   boundary where the two must not disagree.
 */
@Entity('show')
export class Show {
  /** UUIDv7. The partition key of `arthome.catalog.show` (events.md §3). */
  @PrimaryColumn('uuid')
  id!: string;

  /** The workspace that owns the show — `identity.Channel` (§1.5). */
  @Column('text')
  channel_id!: string;

  /** The channel's public face, 1:1 with the channel by `channel_id` (§2.4). */
  @Column('text')
  artist_id!: string;

  @Column('text')
  category_id!: string;

  /**
   * PLURAL, and that is a settled contract decision, not a convenience (E9,
   * §2.6): `taxonomy.json` declares the sub-genre "optional, multiple", the
   * fixture carried it in the singular, and the web filter is a multi-select. A
   * show that is both "contemporary" and "repertoire" exists; the singular
   * forbade it.
   */
  @Column('text', { array: true })
  genre_ids!: string[];

  /**
   * Tags, kept apart from the seven attribute groups. `attributes` in the
   * fixture in fact carried tags — `revival`, `new-creation`, `open-air` — a name
   * collision between two notions, which the contract separates (§2.6).
   * `attributes` itself is absent here: the event does not carry it and nothing
   * in this slice reads it.
   */
  @Column('text', { array: true })
  tag_ids!: string[];

  /** Minutes. A date denormalises this at publication, when it freezes (§2.2). */
  @Column('integer')
  runtime_min!: number;

  /**
   * A member of `LANGUAGE_DEPENDENCIES` — stored as the domain's own spelling,
   * which is also the wire's (code-conventions.md §5.2). Never the Protobuf
   * number: a numeric enum in a column is unreadable in a psql session and
   * meaningless the day the proto renumbers.
   */
  @Column('text')
  language_dependency!: LanguageDependency;

  /** BCP 47. What is PERFORMED — unrelated to the display locale (`LOCALES`). */
  @Column('text', { array: true })
  spoken_languages!: string[];

  @Column('text', { array: true })
  subtitle_languages!: string[];

  @Column('text', { array: true })
  surtitle_languages!: string[];

  /**
   * The declared renditions, as `@arthome/core`'s `MediaSet` — never a URL
   * recipe with a width template. On a television with 1 GB of memory in total, a
   * 4K background decoded for a thumbnail costs as much as a full screen, so the
   * contract serves the sizes actually displayed and the surface takes the
   * nearest one.
   *
   * `jsonb` rather than a `rendition` table: nothing queries inside it, the whole
   * set is always read and written together, and a child table on a
   * CDC-captured schema is one more publication to keep additive (§7.4).
   */
  @Column('jsonb')
  media!: MediaSet;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
