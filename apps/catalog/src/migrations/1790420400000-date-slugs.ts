import type { MigrationInterface, QueryRunner } from 'typeorm';

/** data-model.md §2.7: a slug per language, set once at publication and never changed. */
export class DateSlugs1790420400000 implements MigrationInterface {
  name = 'DateSlugs1790420400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "date"
        ADD COLUMN slug_fr text NULL,
        ADD COLUMN slug_en text NULL
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX date_slug_fr ON "date" (slug_fr) WHERE slug_fr IS NOT NULL',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX date_slug_en ON "date" (slug_en) WHERE slug_en IS NOT NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "date" DROP COLUMN slug_en, DROP COLUMN slug_fr');
  }
}
