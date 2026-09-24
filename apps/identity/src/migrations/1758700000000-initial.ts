import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The identity schema, and the outbox the Debezium router reads.
 *
 * ⚠ ADDITIVE MIGRATIONS ONLY ON `outbox_event`, from here on. The publication
 *   references the columns by name: renaming one breaks replication, and the
 *   connector either fails or loses the column in silence (data-model.md §7.4).
 *   A rename is four steps across two versions — add, backfill, write to both,
 *   drop later — never one.
 */
export class Initial1758700000000 implements MigrationInterface {
  name = 'Initial1758700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `citext` is what makes a handle and an email case-insensitively unique
    // without a functional index on lower(), which every query would then have
    // to remember to match.
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

    // The column names are the Debezium outbox router's, not ours: lowercase
    // and unseparated. Renaming one for readability does not fail a test, it
    // fails the connector (data-model.md §7.3).
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

    // Used by the cleanup job only — the application never reads this table.
    await queryRunner.query(
      'CREATE INDEX idx_outbox_event_created_at ON outbox_event (created_at)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE outbox_event');
    await queryRunner.query('DROP TABLE account');
  }
}
