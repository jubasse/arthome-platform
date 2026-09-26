import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * transport.md §5.4's store. Its primary key is `(account_id, key)`; here that is a unique
 * constraint with NULLS NOT DISTINCT, because `account_id` stays null until tokens are verified.
 */
export class Idempotency1790420000000 implements MigrationInterface {
  name = 'Idempotency1790420000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE idempotency_record (
        key           text        NOT NULL,
        account_id    uuid        NULL,
        fingerprint   text        NOT NULL,
        state         text        NOT NULL CHECK (state IN ('in_flight', 'completed')),
        status_code   integer     NULL,
        response_body jsonb       NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        expires_at    timestamptz NOT NULL,
        CONSTRAINT idempotency_record_scope UNIQUE NULLS NOT DISTINCT (account_id, key)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_idempotency_record_expires_at ON idempotency_record (expires_at)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE idempotency_record');
  }
}
