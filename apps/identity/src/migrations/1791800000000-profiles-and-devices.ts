import type { MigrationInterface, QueryRunner } from 'typeorm';

import { DEVICE_KINDS } from '@arthome/core';

import { PROFILE_KINDS, ProfileKind } from '../profiles/profile-kind.js';

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

/**
 * Auth slice C's first half (PI1): the profile, the registered device and the (device, profile)
 *   binding each better-auth session gets. Every statement may run again: a second `up` on a
 *   backfilled database changes nothing. The uniques are indexes, never inline `NOT NULL UNIQUE`:
 *   no request can collide on them, so they map to no refusal code (`unique-violations.spec.ts`).
 */
export class ProfilesAndDevices1791800000000 implements MigrationInterface {
  name = 'ProfilesAndDevices1791800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS profile (
        id         uuid        PRIMARY KEY,
        account_id uuid        NOT NULL REFERENCES account (id),
        name       text        NOT NULL CHECK (char_length(name) <= 80 AND name ~ '\\S'),
        kind       text        NOT NULL CHECK (kind IN (${sqlList(PROFILE_KINDS)})),
        is_default boolean     NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_default ON profile (account_id) WHERE is_default
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS device (
        id               uuid        PRIMARY KEY,
        token_hash       text        NOT NULL,
        token_expires_at timestamptz NOT NULL,
        kind             text        NOT NULL CHECK (kind IN (${sqlList(DEVICE_KINDS)})),
        label            text        NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
        created_at       timestamptz NOT NULL DEFAULT now(),
        last_seen_at     timestamptz NOT NULL,
        revoked_at       timestamptz NULL
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_device_token_hash ON device (token_hash)
    `);

    // `auth_session_id` names a row of better-auth's schema, which no foreign key reaches (R2).
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS device_session (
        id              uuid        PRIMARY KEY,
        device_id       uuid        NOT NULL REFERENCES device (id),
        account_id      uuid        NOT NULL REFERENCES account (id),
        profile_id      uuid        NOT NULL REFERENCES profile (id),
        auth_session_id text        NOT NULL,
        opened_at       timestamptz NOT NULL,
        closed_at       timestamptz NULL
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_device_session_auth_session
        ON device_session (auth_session_id)
    `);
    // One open binding per (device, profile): a second sign-in of the profile replaces the first.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_device_session_open_pair
        ON device_session (device_id, profile_id) WHERE closed_at IS NULL
    `);
    // Revoking a device closes its open bindings: that update reads them by device.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_device_session_open_device
        ON device_session (device_id) WHERE closed_at IS NULL
    `);

    // uuidv7() is native from Postgres 18: core's ProfileIdSchema refuses any other version.
    await queryRunner.query(`
      INSERT INTO profile (id, account_id, name, kind, is_default)
      SELECT uuidv7(), a.id, a.public_handle::text, '${ProfileKind.ADULT}', true
        FROM account a
       WHERE NOT EXISTS (SELECT 1 FROM profile p WHERE p.account_id = a.id AND p.is_default)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE device_session');
    await queryRunner.query('DROP TABLE device');
    await queryRunner.query('DROP TABLE profile');
  }
}
