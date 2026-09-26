import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type { Bilingual, LanguageDependency } from '@arthome/core';

import type { IndexedRendition } from '../index/show-document.js';

/** What only ShowPublished states about a show. */
export interface PublishedShowFields {
  readonly channel_id: string;
  readonly artist_id: string;
  readonly category_id: string;
  readonly runtime_min: number;
  readonly spoken_languages: readonly string[];
  readonly subtitle_languages: readonly string[];
  readonly surtitle_languages: readonly string[];
  readonly published_at: string;
}

/** What ShowUpdated replaces, and ShowPublished states first. */
export interface UpdatableShowFields {
  readonly genre_ids: readonly string[];
  readonly tag_ids: readonly string[];
  readonly language_dependency: LanguageDependency | null;
  readonly media: {
    readonly wide: readonly IndexedRendition[];
    readonly poster: readonly IndexedRendition[];
  };
  readonly title: Bilingual;
  readonly synopsis: Bilingual;
}

/**
 * The indexer's own copy of a show, fed only by events (critical-rules #1 forbids asking
 * catalog). Two groups, each versioned by the `occurred_at` of the fact that set it: an update
 * that overtakes the publication on a retry topic keeps its newer fields when the publication
 * lands.
 */
@Entity('show_projection')
export class ShowProjection {
  @PrimaryColumn('uuid')
  show_id!: string;

  /** The newest fact applied, in epoch milliseconds: the show document's index version. */
  @Column('bigint')
  version!: string;

  @Column('text', { nullable: true })
  traceparent!: string | null;

  @Column('jsonb', { nullable: true })
  published!: PublishedShowFields | null;

  @Column('bigint', { nullable: true })
  published_version!: string | null;

  @Column('jsonb', { nullable: true })
  updatable!: UpdatableShowFields | null;

  @Column('bigint', { nullable: true })
  updatable_version!: string | null;

  @Index('show_projection_indexed_at')
  @Column('timestamptz', { default: () => 'now()' })
  indexed_at!: Date;
}
