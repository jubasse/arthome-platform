import type { MigrationInterface, QueryRunner } from 'typeorm';

import { REPLAY_STATES, ReplayState } from '@arthome/core';

function oneOf(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * data-model.md §2.2's `Replay`, one per date whose live ended with a replay promised, and its facts
 *   on the public page's read model. No backfill: no `Replay` exists before this release, and the
 *   file messages consumed until now were ignored.
 */
export class Replay1790421000000 implements MigrationInterface {
  name = 'Replay1790421000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE replay (
        date_id            uuid        PRIMARY KEY REFERENCES "date" (id),
        channel_id         text        NOT NULL,
        state              text        NOT NULL CHECK (state IN (${oneOf(REPLAY_STATES)})),
        policy             text        NOT NULL,
        live_ended_at      timestamptz NOT NULL,
        closes_at          timestamptz NOT NULL,
        asset_duration_sec integer     NULL CHECK (asset_duration_sec >= 0),
        asset_ready_at     timestamptz NULL,
        online_at          timestamptz NULL,
        closed_at          timestamptz NULL,
        withdrawn_at       timestamptz NULL,
        version            integer     NOT NULL CHECK (version >= 1),
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        -- Gone online, it keeps its online_at once closed or withdrawn; pending, it never had one.
        CHECK (state <> '${ReplayState.ONLINE}' OR online_at IS NOT NULL),
        CHECK (state <> '${ReplayState.PENDING}' OR online_at IS NULL),
        CHECK (state <> '${ReplayState.ONLINE}' OR asset_ready_at IS NOT NULL),
        CHECK ((closed_at IS NOT NULL) = (state = '${ReplayState.CLOSED}')),
        CHECK ((withdrawn_at IS NOT NULL) = (state = '${ReplayState.WITHDRAWN}'))
      )
    `);
    await queryRunner.query(`
      ALTER TABLE date_detail_public
        ADD COLUMN replay_state text NULL,
        ADD COLUMN replay_closes_at timestamptz NULL,
        ADD COLUMN replay_online_at timestamptz NULL,
        ADD COLUMN replay_duration_sec integer NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE date_detail_public
        DROP COLUMN replay_duration_sec,
        DROP COLUMN replay_online_at,
        DROP COLUMN replay_closes_at,
        DROP COLUMN replay_state
    `);
    await queryRunner.query('DROP TABLE replay');
  }
}
