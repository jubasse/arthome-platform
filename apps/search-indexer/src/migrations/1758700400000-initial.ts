import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * No outbox and no replication slot: this service only consumes, and a slot created
 *   for symmetry then left unread retains the write-ahead log until the disk is full.
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
    // Plain, not unique: it serves the by-hand "what has the projector touched since X"
    // that spots a stalled consumer, and spares it a scan of the whole catalogue.
    await queryRunner.query(
      'CREATE INDEX show_projection_indexed_at ON show_projection (indexed_at)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE show_projection');
    await queryRunner.query('DROP TABLE processed_message');
  }
}
