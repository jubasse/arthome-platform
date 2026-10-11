import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The preview budget and the resume points (PS4). A budget row is one account's on one date,
 *   whatever its devices; a resume point is one profile's on one date, read by its primary key.
 *   `incident_by_run` is the budget's read of a run's veils: only the open incident was indexed.
 *   `settled_ms` is in milliseconds so no settle drops a remainder; it never passes the budget's
 *   300 000, so an integer holds it.
 */
export class PreviewAndResume1791800000000 implements MigrationInterface {
  name = 'PreviewAndResume1791800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE preview_budget (
        account_id uuid NOT NULL,
        date_id uuid NOT NULL,
        settled_ms integer NOT NULL DEFAULT 0 CHECK (settled_ms >= 0),
        covered_until timestamptz NULL,
        settled_until timestamptz NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (account_id, date_id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE resume_point (
        owner_id uuid NOT NULL,
        date_id uuid NOT NULL,
        account_id uuid NOT NULL,
        profile_id uuid NULL,
        device_id uuid NOT NULL,
        position_sec integer NOT NULL CHECK (position_sec >= 0),
        completed boolean NOT NULL,
        version bigint NOT NULL CHECK (version >= 1),
        written_at timestamptz NOT NULL,
        PRIMARY KEY (owner_id, date_id)
      )
    `);
    await queryRunner.query('CREATE INDEX incident_by_run ON incident (run_id)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX incident_by_run');
    await queryRunner.query('DROP TABLE resume_point');
    await queryRunner.query('DROP TABLE preview_budget');
  }
}
