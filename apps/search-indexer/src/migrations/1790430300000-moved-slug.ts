import type { MigrationInterface, QueryRunner } from 'typeorm';

/** D-075: a postponement moves the date's slug and URL with its start. */
export class MovedSlug1790430300000 implements MigrationInterface {
  name = 'MovedSlug1790430300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE date_projection
        ADD COLUMN moved_slug text NULL,
        ADD COLUMN moved_canonical_url text NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE date_projection DROP COLUMN moved_canonical_url, DROP COLUMN moved_slug',
    );
  }
}
