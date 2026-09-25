import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ⚠ ADDITIVE MIGRATIONS ONLY ON `outbox_event` from here on: the publication references
 *   the columns by name, and a rename breaks replication or loses the column in silence
 *   (data-model.md §7.4).
 */
export class Initial1758700000000 implements MigrationInterface {
  name = 'Initial1758700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `citext` is what makes a handle and an email case-insensitively unique without a functional index every query must match.
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS citext');

    await queryRunner.query(`
      CREATE TABLE account (
        id            uuid        PRIMARY KEY,
        public_handle citext      NOT NULL UNIQUE,
        email         citext      NOT NULL UNIQUE,
        locale        text        NOT NULL,
        country       text        NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      )
    `);

    // The column names are the Debezium outbox router's, not ours: renaming one for readability fails the connector, not a test.
    await queryRunner.query(`
      CREATE TABLE outbox_event (
        id            uuid        PRIMARY KEY,
        aggregatetype text        NOT NULL,
        aggregateid   text        NOT NULL,
        type          text        NOT NULL,
        payload       bytea       NOT NULL,
        tracecontext  text        NULL,
        actor_id      text        NULL,
        created_at    timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      'CREATE INDEX idx_outbox_event_created_at ON outbox_event (created_at)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE outbox_event');
    await queryRunner.query('DROP TABLE account');
  }
}
