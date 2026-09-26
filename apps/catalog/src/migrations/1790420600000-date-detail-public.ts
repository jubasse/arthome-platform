import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * data-model.md §4's `date_detail_public`, backfilled with every date already public: a date has
 * slugs exactly once it is published, and they never go.
 */
export class DateDetailPublic1790420600000 implements MigrationInterface {
  name = 'DateDetailPublic1790420600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE date_detail_public (
        date_id uuid PRIMARY KEY,
        show_id uuid NOT NULL,
        channel_id text NOT NULL,
        venue_id uuid NOT NULL,
        venue_name text NOT NULL,
        venue_city text NOT NULL,
        venue_country text NOT NULL,
        venue_timezone text NOT NULL,
        starts_at timestamptz NOT NULL,
        runtime_min integer NOT NULL,
        replay_policy text NOT NULL,
        replay_window_hours integer NOT NULL,
        rights jsonb NOT NULL,
        slug_fr text NOT NULL,
        slug_en text NOT NULL,
        publication_state text NOT NULL,
        artist_id text NOT NULL,
        category_id text NOT NULL,
        genre_ids text[] NOT NULL,
        tag_ids text[] NOT NULL,
        language_dependency text NOT NULL,
        spoken_languages text[] NOT NULL,
        subtitle_languages text[] NOT NULL,
        surtitle_languages text[] NOT NULL,
        media jsonb NOT NULL,
        title jsonb NOT NULL,
        synopsis jsonb NOT NULL,
        version bigint NOT NULL DEFAULT 1,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX date_detail_public_show_id ON date_detail_public (show_id)',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX date_detail_public_slug_fr ON date_detail_public (slug_fr)',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX date_detail_public_slug_en ON date_detail_public (slug_en)',
    );
    await queryRunner.query(`
      INSERT INTO date_detail_public (
        date_id, show_id, channel_id, venue_id, venue_name, venue_city, venue_country,
        venue_timezone, starts_at, runtime_min, replay_policy, replay_window_hours, rights,
        slug_fr, slug_en, publication_state, artist_id, category_id, genre_ids, tag_ids,
        language_dependency, spoken_languages, subtitle_languages, surtitle_languages, media,
        title, synopsis
      )
      SELECT d.id, d.show_id, d.channel_id, d.venue_id, v.name, v.city, v.country, v.time_zone,
             d.starts_at, d.runtime_min, d.replay_policy, COALESCE(d.replay_window_hours, 0),
             d.rights, d.slug_fr, d.slug_en, p.state, s.artist_id, s.category_id, s.genre_ids,
             s.tag_ids, s.language_dependency, s.spoken_languages, s.subtitle_languages,
             s.surtitle_languages, s.media, s.title, s.synopsis
        FROM "date" d
        JOIN publication p ON p.date_id = d.id
        JOIN "show" s ON s.id = d.show_id
        JOIN venue v ON v.id = d.venue_id
       WHERE d.slug_fr IS NOT NULL AND d.slug_en IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE date_detail_public');
  }
}
