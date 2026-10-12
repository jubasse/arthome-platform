import type { MigrationInterface, QueryRunner } from 'typeorm';

/** RS1: the Replay's facts, from catalog.replay.state_changed.v1. */
export class Replay1790430400000 implements MigrationInterface {
  name = 'Replay1790430400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE date_projection
        ADD COLUMN replay_state text NULL,
        ADD COLUMN replay_live_ended_at timestamptz NULL,
        ADD COLUMN replay_closes_at timestamptz NULL,
        ADD COLUMN replay_online_at timestamptz NULL,
        ADD COLUMN replay_duration_sec integer NULL,
        ADD COLUMN replay_version bigint NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE date_projection
        DROP COLUMN replay_version,
        DROP COLUMN replay_duration_sec,
        DROP COLUMN replay_online_at,
        DROP COLUMN replay_closes_at,
        DROP COLUMN replay_live_ended_at,
        DROP COLUMN replay_state
    `);
  }
}
