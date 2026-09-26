import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The indexer keeps its own copy of shows and dates, so a date document can carry its show's
 * fields and be recomposed when either changes. Existing show rows have no fields yet: replay
 * `arthome.catalog.show` to fill them.
 */
export class ReadModel1790430000000 implements MigrationInterface {
  name = 'ReadModel1790430000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE show_projection
        ADD COLUMN published         jsonb  NULL,
        ADD COLUMN published_version bigint NULL,
        ADD COLUMN updatable         jsonb  NULL,
        ADD COLUMN updatable_version bigint NULL
    `);
    await queryRunner.query(`
      CREATE TABLE date_projection (
        date_id             uuid        PRIMARY KEY,
        show_id             uuid        NULL,
        scheduled           jsonb       NULL,
        scheduled_version   bigint      NULL,
        publication_state   text        NULL,
        publication_version bigint      NULL,
        doc_version         bigint      NOT NULL DEFAULT 0,
        indexed_at          timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX date_projection_show_id ON date_projection (show_id)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE date_projection');
    await queryRunner.query(`
      ALTER TABLE show_projection
        DROP COLUMN updatable_version, DROP COLUMN updatable,
        DROP COLUMN published_version, DROP COLUMN published
    `);
  }
}
