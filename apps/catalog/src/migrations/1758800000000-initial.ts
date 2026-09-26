import { outboxTableDdl } from '@arthome-platform/messaging';
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The outbox comes from `outboxTableDdl()`, guards included, in one step. The helper
 *   carries the columns the router requires AND the four constraints that make a
 *   connector-killing row impossible to commit; writing the DDL out here would be a seventh
 *   copy of a contract that belongs to Debezium, where drift is silent until it is not.
 * Additive migrations only on `outbox_event` from here on: the publication references the
 *   columns by name, so renaming one breaks replication and the connector either fails or
 *   loses the column in silence (§7.4). A rename is four steps across two versions.
 */
export class Initial1758800000000 implements MigrationInterface {
  name = 'Initial1758800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `show` is quoted deliberately: `SHOW` is a Postgres command word, and TypeORM quotes
    //   the identifier in every statement it generates from `@Entity('show')`, so an unquoted
    //   table here would be the one spelling that differs.
    await queryRunner.query(`
      CREATE TABLE "show" (
        id                  uuid        PRIMARY KEY,
        channel_id          text        NOT NULL,
        artist_id           text        NOT NULL,
        category_id         text        NOT NULL,
        genre_ids           text[]      NOT NULL DEFAULT '{}',
        tag_ids             text[]      NOT NULL DEFAULT '{}',
        runtime_min         integer     NOT NULL,
        language_dependency text        NOT NULL,
        spoken_languages    text[]      NOT NULL DEFAULT '{}',
        subtitle_languages  text[]      NOT NULL DEFAULT '{}',
        surtitle_languages  text[]      NOT NULL DEFAULT '{}',
        media               jsonb       NOT NULL,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now()
      )
    `);

    // The catalogue is browsed by channel on every studio screen.
    await queryRunner.query('CREATE INDEX idx_show_channel_id ON "show" (channel_id)');

    await queryRunner.query(outboxTableDdl());

    // Not part of `outboxTableDdl()`, and it should be — every service has to remember it
    //   separately, which is how one of them will not (recorded in HANDOVER.md). Used by the
    //   cleanup job only: the application never reads this table, CDC reads the WAL.
    await queryRunner.query(
      'CREATE INDEX idx_outbox_event_created_at ON outbox_event (created_at)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE outbox_event');
    await queryRunner.query('DROP TABLE "show"');
  }
}
