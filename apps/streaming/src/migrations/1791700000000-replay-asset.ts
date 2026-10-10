import type { MigrationInterface, QueryRunner } from 'typeorm';

import { REPLAY_ASSET_STATES, ReplayAssetState } from '@arthome/core';

function oneOf(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * The replay asset (PS5): one row per recorded date, its provider call beside it (attempts, next
 *   attempt, dead mark) the way the review checklist's provider-call row has it. The three partial
 *   indexes are the passes': the calls due, the assets expiring, the assets a withdrawal can reach.
 */
export class ReplayAsset1791700000000 implements MigrationInterface {
  name = 'ReplayAsset1791700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE replay_asset (
        date_id uuid PRIMARY KEY,
        channel_id uuid NOT NULL,
        state text NOT NULL CHECK (state IN (${oneOf(REPLAY_ASSET_STATES)})),
        recording_ref text NULL,
        recorded_from timestamptz NOT NULL,
        recorded_until timestamptz NULL,
        stopped_at timestamptz NULL,
        duration_sec integer NULL CHECK (duration_sec >= 0),
        available_from timestamptz NULL,
        expires_at timestamptz NULL,
        announced_at timestamptz NULL,
        call_attempts integer NOT NULL DEFAULT 0,
        call_next_attempt_at timestamptz NULL,
        call_dead_at timestamptz NULL,
        failed_call text NULL,
        deleted_at timestamptz NULL,
        version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (state <> '${ReplayAssetState.READY}' OR expires_at IS NOT NULL),
        CHECK ((state = '${ReplayAssetState.DELETED}') = (deleted_at IS NOT NULL)),
        CHECK ((state = '${ReplayAssetState.FAILED}') = (call_dead_at IS NOT NULL))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX replay_asset_calls_due ON replay_asset (call_next_attempt_at)
       WHERE call_dead_at IS NULL
         AND state IN ('${ReplayAssetState.RECORDING}', '${ReplayAssetState.PROCESSING}',
                       '${ReplayAssetState.DELETING}')
    `);
    await queryRunner.query(`
      CREATE INDEX replay_asset_expiring ON replay_asset (expires_at)
       WHERE state = '${ReplayAssetState.READY}'
    `);
    await queryRunner.query(`
      CREATE INDEX replay_asset_withdrawable ON replay_asset (date_id)
       WHERE state IN ('${ReplayAssetState.RECORDING}', '${ReplayAssetState.PROCESSING}',
                       '${ReplayAssetState.READY}')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE replay_asset');
  }
}
