import type { MigrationInterface, QueryRunner } from 'typeorm';

import { SeatState } from '@arthome/core';

/**
 * The entitlement projection (`data-model.md` §4), three tables under one prefix: the seats, one
 *   row per date in groups each kept with its own instant, and one subscription per account.
 */
export class EntitlementProjection1791636545325 implements MigrationInterface {
  name = 'EntitlementProjection1791636545325';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE entitlement_seat (
        seat_id     uuid        PRIMARY KEY,
        account_id  uuid        NOT NULL,
        date_id     uuid        NOT NULL,
        state       text        NOT NULL CHECK (state IN ('${SeatState.ACTIVE}', '${SeatState.CANCELLED}')),
        occurred_at timestamptz NOT NULL,
        applied_at  timestamptz NOT NULL
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_entitlement_seat_account_date ON entitlement_seat (account_id, date_id)',
    );
    await queryRunner.query(`
      CREATE TABLE entitlement_date (
        date_id              uuid        PRIMARY KEY,
        channel_id           text,
        starts_at            timestamptz,
        runtime_min          integer,
        timing_occurred_at   timestamptz,
        replay_policy        text,
        replay_window_hours  integer,
        replay_occurred_at   timestamptz,
        rights_scope         text,
        blackout_countries   text[],
        blackout_reason      text,
        rights_occurred_at   timestamptz,
        publication_state    text,
        publication_version  bigint,
        outcome              text,
        outcome_declared_at  timestamptz,
        applied_at           timestamptz NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE TABLE entitlement_subscription (
        account_id   uuid        PRIMARY KEY,
        plan         text,
        state        text,
        openings     text[]      NOT NULL,
        paid_through timestamptz,
        occurred_at  timestamptz NOT NULL,
        applied_at   timestamptz NOT NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE entitlement_subscription');
    await queryRunner.query('DROP TABLE entitlement_date');
    await queryRunner.query('DROP TABLE entitlement_seat');
  }
}
