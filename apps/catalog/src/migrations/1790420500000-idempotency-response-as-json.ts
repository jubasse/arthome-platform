import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A replay returns the first response verbatim (transport.md §5.4), and `jsonb` reorders an
 * object's keys: the replayed body was equal in content and different in bytes. `json` keeps the
 * text as written.
 */
export class IdempotencyResponseAsJson1790420500000 implements MigrationInterface {
  name = 'IdempotencyResponseAsJson1790420500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE idempotency_record ALTER COLUMN response_body TYPE json USING response_body::json',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE idempotency_record ALTER COLUMN response_body TYPE jsonb USING response_body::jsonb',
    );
  }
}
