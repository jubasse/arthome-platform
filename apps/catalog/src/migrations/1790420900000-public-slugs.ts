import { readPublicWebOrigin } from '@arthome-platform/config';
import type { MigrationInterface, QueryRunner } from 'typeorm';

import { DateOutcome, type Bilingual } from '@arthome/core';

import { writeDateScheduled } from '../dates/announce-publication.js';
import { dateRecordsOf } from '../dates/date-records.js';
import { dateSlugCandidates, showSlugCandidates } from '../dates/slug.js';

/**
 * D-075: one slug per show and per date, no language in a URL, and `public_slug_alias` for the
 * slugs replaced from now on. The per-language URLs were never served outside development, so none
 * is carried over. Existing rows are slugged with the same functions the commands use, so a
 * backfilled slug is one a command would have picked, and every published date states its facts
 * again with its new URL. Consumers deploy first: one still on the old DateScheduled would read the
 * new one without a slug.
 */
export class PublicSlugs1790420900000 implements MigrationInterface {
  name = 'PublicSlugs1790420900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "show" ADD COLUMN slug text NULL');
    const shows = await queryRunner.manager.query<{ id: string; title: Bilingual }[]>(
      'SELECT id, title FROM "show" ORDER BY created_at, id',
    );
    const showSlugs = new Set<string>();
    for (const show of shows) {
      const slug =
        showSlugCandidates(show.title, show.id).find((c) => !showSlugs.has(c)) ?? show.id;
      showSlugs.add(slug);
      await queryRunner.query('UPDATE "show" SET slug = $2 WHERE id = $1', [show.id, slug]);
    }
    await queryRunner.query('ALTER TABLE "show" ALTER COLUMN slug SET NOT NULL');
    await queryRunner.query('CREATE UNIQUE INDEX show_slug ON "show" (slug)');

    await queryRunner.query(`
      ALTER TABLE "date"
        ADD COLUMN slug text NULL,
        ADD COLUMN postponements integer NOT NULL DEFAULT 0
    `);
    // A date has slugs exactly once it is published.
    const dates = await queryRunner.manager.query<
      { id: string; show_id: string; starts_at: Date; time_zone: string }[]
    >(`
      SELECT d.id, d.show_id, d.starts_at, v.time_zone
        FROM "date" d JOIN venue v ON v.id = d.venue_id
       WHERE d.slug_fr IS NOT NULL
       ORDER BY d.starts_at, d.id
    `);
    const dateSlugs = new Map<string, Set<string>>();
    for (const date of dates) {
      const taken = dateSlugs.get(date.show_id) ?? new Set<string>();
      const candidates = dateSlugCandidates(date.starts_at.toISOString(), date.time_zone, date.id);
      const slug = candidates.find((c) => !taken.has(c)) ?? date.id;
      taken.add(slug);
      dateSlugs.set(date.show_id, taken);
      await queryRunner.query('UPDATE "date" SET slug = $2 WHERE id = $1', [date.id, slug]);
    }
    // A postponed date was postponed once: D-074 allowed no second one.
    await queryRunner.query('UPDATE "date" SET postponements = 1 WHERE outcome = $1', [
      DateOutcome.POSTPONED,
    ]);
    await queryRunner.query(
      'CREATE UNIQUE INDEX date_show_slug ON "date" (show_id, slug) WHERE slug IS NOT NULL',
    );
    await queryRunner.query('ALTER TABLE "date" DROP COLUMN slug_fr, DROP COLUMN slug_en');

    await queryRunner.query(
      'ALTER TABLE date_detail_public ADD COLUMN show_slug text NULL, ADD COLUMN slug text NULL',
    );
    await queryRunner.query(`
      UPDATE date_detail_public p
         SET show_slug = s.slug, slug = d.slug
        FROM "date" d JOIN "show" s ON s.id = d.show_id
       WHERE d.id = p.date_id
    `);
    await queryRunner.query(`
      ALTER TABLE date_detail_public
        ALTER COLUMN show_slug SET NOT NULL,
        ALTER COLUMN slug SET NOT NULL,
        DROP COLUMN slug_fr,
        DROP COLUMN slug_en
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX date_detail_public_slug ON date_detail_public (show_id, slug)',
    );

    const occurredAt = new Date();
    const origin = readPublicWebOrigin();
    for (const { id } of dates) {
      const records = await dateRecordsOf(queryRunner.manager, id);
      const { slug } = records.date;
      if (slug === null) throw new Error(`date ${id} lost the slug it was just given`);
      const date = { ...records.date, slug };
      await writeDateScheduled(queryRunner.manager, { ...records, date }, origin, occurredAt, null);
    }

    // `scope` narrows a date's slug to its show; it is empty for a show and an artist.
    await queryRunner.query(`
      CREATE TABLE public_slug_alias (
        kind text NOT NULL,
        scope text NOT NULL,
        slug text NOT NULL,
        target_id uuid NOT NULL,
        expires_at timestamptz NOT NULL,
        PRIMARY KEY (kind, scope, slug)
      )
    `);
  }

  /** `{show-slug}-{date-slug}` is unique across dates, as the old per-language slugs were. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE public_slug_alias');

    await queryRunner.query(
      'ALTER TABLE date_detail_public ADD COLUMN slug_fr text NULL, ADD COLUMN slug_en text NULL',
    );
    await queryRunner.query(`
      UPDATE date_detail_public
         SET slug_fr = show_slug || '-' || slug, slug_en = show_slug || '-' || slug
    `);
    await queryRunner.query(`
      ALTER TABLE date_detail_public
        ALTER COLUMN slug_fr SET NOT NULL,
        ALTER COLUMN slug_en SET NOT NULL,
        DROP COLUMN slug,
        DROP COLUMN show_slug
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX date_detail_public_slug_fr ON date_detail_public (slug_fr)',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX date_detail_public_slug_en ON date_detail_public (slug_en)',
    );

    await queryRunner.query(
      'ALTER TABLE "date" ADD COLUMN slug_fr text NULL, ADD COLUMN slug_en text NULL',
    );
    await queryRunner.query(`
      UPDATE "date" d
         SET slug_fr = s.slug || '-' || d.slug, slug_en = s.slug || '-' || d.slug
        FROM "show" s
       WHERE s.id = d.show_id AND d.slug IS NOT NULL
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX date_slug_fr ON "date" (slug_fr) WHERE slug_fr IS NOT NULL',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX date_slug_en ON "date" (slug_en) WHERE slug_en IS NOT NULL',
    );
    await queryRunner.query('ALTER TABLE "date" DROP COLUMN slug, DROP COLUMN postponements');
    await queryRunner.query('ALTER TABLE "show" DROP COLUMN slug');
  }
}
