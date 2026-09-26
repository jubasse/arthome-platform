import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import type { Bilingual, LanguageDependency, MediaSet } from '@arthome/core';

/**
 * The root aggregate of `catalog` (data-model.md §2.1), sliced to what `ShowPublished` carries.
 *
 * The column is `category_id` where the domain document says "discipline". The wire decides
 *   (code-conventions.md §5.2) and `ShowPublished.category_id` is published and stable, so
 *   renaming it here puts a second name on one concept at the boundary where the two must agree.
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

  /** Plural per E9 and §2.6: a show that is both "contemporary" and "repertoire" exists. */
  @Column('text', { array: true })
  genre_ids!: string[];

  @Column('text', { array: true })
  tag_ids!: string[];

  @Column('integer')
  runtime_min!: number;

  /** The domain's spelling, never the Protobuf number: unreadable in psql and wrong the day the proto renumbers. */
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
   * `jsonb` rather than a `rendition` table: nothing queries inside it, the whole set is always
   * read and written together, and a child table on a CDC-captured schema is one more
   * publication to keep additive (§7.4).
   */
  @Column('jsonb')
  media!: MediaSet;

  /** Both languages where they exist (§2.1); an empty side is absent copy, which the checklist reads. */
  @Column('jsonb')
  title!: Bilingual;

  @Column('jsonb')
  synopsis!: Bilingual;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
