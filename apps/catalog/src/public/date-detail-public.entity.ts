import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type {
  Bilingual,
  DateOutcome,
  LanguageDependency,
  MediaSet,
  PublicationState,
  ReplayPolicy,
  TerritoryRights,
} from '@arthome/core';

/**
 * data-model.md §4's `date_detail_public`: one row per public date, its show and venue copied in,
 * written by catalog's own commands in their transaction and read in one query. No screen is
 * served by a join at query time.
 */
@Entity('date_detail_public')
export class DateDetailPublic {
  @PrimaryColumn('uuid')
  date_id!: string;

  @Index('date_detail_public_show_id')
  @Column('uuid')
  show_id!: string;

  @Column('text')
  channel_id!: string;

  @Column('uuid')
  venue_id!: string;

  @Column('text')
  venue_name!: string;

  @Column('text')
  venue_city!: string;

  @Column('text')
  venue_country!: string;

  @Column('text')
  venue_timezone!: string;

  @Column('timestamptz')
  starts_at!: Date;

  @Column('integer')
  runtime_min!: number;

  @Column('text')
  replay_policy!: ReplayPolicy;

  /** 0 without a replay window, as the search index holds it. */
  @Column('integer')
  replay_window_hours!: number;

  @Column('jsonb')
  rights!: TerritoryRights;

  @Column('text')
  show_slug!: string;

  @Column('text')
  slug!: string;

  @Column('text')
  publication_state!: PublicationState;

  @Column('text', { nullable: true })
  outcome!: DateOutcome | null;

  /** The channel's public face, when it has one: a card names its artist. */
  @Column('text', { nullable: true })
  artist_name!: string | null;

  @Column('timestamptz', { nullable: true })
  rescheduled_to!: Date | null;

  @Column('text')
  artist_id!: string;

  @Column('text')
  category_id!: string;

  @Column('text', { array: true })
  genre_ids!: string[];

  @Column('text', { array: true })
  tag_ids!: string[];

  @Column('text')
  language_dependency!: LanguageDependency;

  @Column('text', { array: true })
  spoken_languages!: string[];

  @Column('text', { array: true })
  subtitle_languages!: string[];

  @Column('text', { array: true })
  surtitle_languages!: string[];

  @Column('jsonb')
  media!: MediaSet;

  @Column('jsonb')
  title!: Bilingual;

  @Column('jsonb')
  synopsis!: Bilingual;

  /** data-model.md §4: every read model carries a monotonic version and when it was applied. */
  @Column('bigint', { default: 1 })
  version!: string;

  @Column('timestamptz', { default: () => 'now()' })
  applied_at!: Date;
}
