import type { MigrationInterface, QueryRunner } from 'typeorm';

import { ReplayAssetState, RunState } from '@arthome/core';

/**
 * What the operational checks read (SO1). `orphan_recording` is a recording the provider keeps
 *   that no asset owns, its deletion given up; the reference stays in its column and in no log.
 *   The partial indexes serve the count of `failed` assets and the runs not yet on air, a handful
 *   among every date's row.
 */
export class OpsChecks1791900000000 implements MigrationInterface {
  name = 'OpsChecks1791900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE orphan_recording (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        date_id uuid NOT NULL,
        recording_ref text NOT NULL UNIQUE,
        attempts integer NOT NULL CHECK (attempts >= 1),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX replay_asset_failed ON replay_asset (call_dead_at)
       WHERE state = '${ReplayAssetState.FAILED}'
    `);
    await queryRunner.query(`
      CREATE INDEX run_not_started ON run (date_id)
       WHERE state IN ('${RunState.IDLE}', '${RunState.REHEARSAL}')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX run_not_started');
    await queryRunner.query('DROP INDEX replay_asset_failed');
    await queryRunner.query('DROP TABLE orphan_recording');
  }
}
