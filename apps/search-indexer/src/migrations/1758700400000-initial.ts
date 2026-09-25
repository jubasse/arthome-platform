import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The `search` database: a deduplication key and a projection ledger.
 *
 * ⚠ NO `outbox_event` HERE, AND THAT IS THE POINT OF THE SERVICE. This one
 *   only consumes: it publishes nothing, so it needs no outbox, no replication
 *   slot and no connector. A slot created "for symmetry" and then left unread
 *   retains the write-ahead log until the disk is full (data-model.md §7.4).
 */
export class Initial1758700400000 implements MigrationInterface {
  name = 'Initial1758700400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE processed_message (
        id           uuid        PRIMARY KEY,
        topic        text        NOT NULL,
        processed_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE show_projection (
        show_id     uuid        PRIMARY KEY,
        version     bigint      NOT NULL,
        traceparent text        NULL,
        indexed_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    // ⚠ NOT A UNIQUE INDEX AND NOT A CONSTRAINT — a plain one, for the
    //   question this table is asked by hand: "what has the projector
    //   touched since X", which is how a stalled consumer is spotted. Without
    //   it that query is a sequential scan of the whole catalogue, which is
    //   cheap enough today to hide the day it is not.
    await queryRunner.query(
      'CREATE INDEX show_projection_indexed_at ON show_projection (indexed_at)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE show_projection');
    await queryRunner.query('DROP TABLE processed_message');
  }
}
