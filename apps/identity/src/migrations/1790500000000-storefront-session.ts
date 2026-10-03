import { idempotencyRecordTableDdl } from '@arthome-platform/http-edge';
import type { MigrationInterface, QueryRunner } from 'typeorm';

import { AccountStatus } from '@arthome/core';

/**
 * Auth slice A: the account's status, verified address and accepted terms, the verification links,
 *   and transport.md §5.4's idempotency store. better-auth's tables are not here: `migration:auth`
 *   writes them in the `auth` schema.
 */
export class StorefrontSession1790500000000 implements MigrationInterface {
  name = 'StorefrontSession1790500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE account
        ADD COLUMN status            text        NOT NULL DEFAULT '${AccountStatus.ACTIVE}',
        ADD COLUMN email_verified_at timestamptz NULL,
        ADD COLUMN terms_version     integer     NULL,
        ADD COLUMN terms_accepted_at timestamptz NULL
    `);

    await queryRunner.query(`
      CREATE TABLE email_verification (
        token_hash text        PRIMARY KEY,
        account_id uuid        NOT NULL REFERENCES account (id),
        email      citext      NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at    timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // A resend spends an account's outstanding links: that update reads them by account.
    await queryRunner.query(`
      CREATE INDEX idx_email_verification_outstanding
        ON email_verification (account_id) WHERE used_at IS NULL
    `);

    await queryRunner.query(idempotencyRecordTableDdl());
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE idempotency_record');
    await queryRunner.query('DROP TABLE email_verification');
    await queryRunner.query(`
      ALTER TABLE account
        DROP COLUMN terms_accepted_at,
        DROP COLUMN terms_version,
        DROP COLUMN email_verified_at,
        DROP COLUMN status
    `);
  }
}
