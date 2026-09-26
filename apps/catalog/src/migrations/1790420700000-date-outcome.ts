import type { MigrationInterface, QueryRunner } from 'typeorm';

/** data-model.md §2.2's outcome on a date, and its copy on the public page's read model. */
export class DateOutcome1790420700000 implements MigrationInterface {
  name = 'DateOutcome1790420700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "date"
        ADD COLUMN outcome text NULL,
        ADD COLUMN rescheduled_to timestamptz NULL,
        ADD COLUMN outcome_declared_at timestamptz NULL,
        ADD COLUMN outcome_message jsonb NULL
    `);
    await queryRunner.query(`
      ALTER TABLE date_detail_public
        ADD COLUMN outcome text NULL,
        ADD COLUMN rescheduled_to timestamptz NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE date_detail_public DROP COLUMN rescheduled_to, DROP COLUMN outcome',
    );
    await queryRunner.query(`
      ALTER TABLE "date"
        DROP COLUMN outcome_message,
        DROP COLUMN outcome_declared_at,
        DROP COLUMN rescheduled_to,
        DROP COLUMN outcome
    `);
  }
}
