import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A date's outcome and the start a postponement moved it to, each with its own version. */
export class DateOutcome1790430100000 implements MigrationInterface {
  name = 'DateOutcome1790430100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE date_projection
        ADD COLUMN outcome text NULL,
        ADD COLUMN outcome_rescheduled_to timestamptz NULL,
        ADD COLUMN outcome_version bigint NULL,
        ADD COLUMN moved_starts_at timestamptz NULL,
        ADD COLUMN moved_version bigint NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE date_projection
        DROP COLUMN moved_version,
        DROP COLUMN moved_starts_at,
        DROP COLUMN outcome_version,
        DROP COLUMN outcome_rescheduled_to,
        DROP COLUMN outcome
    `);
  }
}
