import type { MigrationInterface, QueryRunner } from 'typeorm';

import {
  REPLAY_ACCESS_ORIGINS,
  REPLAY_ACCESS_REVOCATION_REASONS,
  REPLAY_POLICIES,
  REPLAY_STATES,
  ReplayState,
} from '@arthome/core';

const listOf = (members: readonly string[]) => members.map((member) => `'${member}'`).join(', ');

/**
 * Ticketing's copy of each date's `Replay` and the `included` accesses of its seats (HANDOVER
 *   §0r). No backfill: no `Replay` was ever published before this release.
 */
export class ReplayAccess1791700000000 implements MigrationInterface {
  name = 'ReplayAccess1791700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE replay_window (
        date_id       uuid        PRIMARY KEY,
        state         text        NOT NULL CHECK (state IN (${listOf(REPLAY_STATES)})),
        version       bigint      NOT NULL,
        policy        text        NOT NULL CHECK (policy IN (${listOf(REPLAY_POLICIES)})),
        live_ended_at timestamptz NOT NULL,
        closes_at     timestamptz NOT NULL,
        online_at     timestamptz NULL,
        granted_at    timestamptz NULL,
        revoked_at    timestamptz NULL,
        recorded_at   timestamptz NOT NULL,
        CONSTRAINT replay_window_revoked_when_withdrawn
          CHECK (revoked_at IS NULL OR state = '${ReplayState.WITHDRAWN}')
      )
    `);
    await queryRunner.query(`
      CREATE TABLE replay_access (
        id                uuid        PRIMARY KEY,
        date_id           uuid        NOT NULL,
        seat_id           uuid        NOT NULL UNIQUE REFERENCES seat (id),
        origin            text        NOT NULL CHECK (origin IN (${listOf(REPLAY_ACCESS_ORIGINS)})),
        granted_at        timestamptz NOT NULL,
        revoked_at        timestamptz NULL,
        revocation_reason text        NULL
          CHECK (revocation_reason IN (${listOf(REPLAY_ACCESS_REVOCATION_REASONS)})),
        CONSTRAINT replay_access_revoked_with_reason
          CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_replay_access_date_live ON replay_access (date_id)
        WHERE revoked_at IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE replay_access`);
    await queryRunner.query(`DROP TABLE replay_window`);
  }
}
