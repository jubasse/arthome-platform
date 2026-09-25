import { outboxTableDdl } from '@arthome-platform/messaging';
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The catalog schema, and the outbox the Debezium router reads.
 *
 * ⚠ THE OUTBOX COMES FROM `outboxTableDdl()`, GUARDS INCLUDED, IN ONE STEP.
 *   Identity created the table by hand and added the CHECK constraints in a
 *   second migration two hundred seconds later, because the constraints were
 *   written only after a malformed row had killed a connector. There is no reason
 *   to repeat the two-step: the helper carries the columns the router requires
 *   AND the four constraints that make a connector-killing row impossible to
 *   commit. Writing the DDL out here instead would be seven copies of a contract
 *   that belongs to Debezium, in the one place where drift is silent until it is
 *   catastrophic.
 *
 * ⚠ ADDITIVE MIGRATIONS ONLY ON `outbox_event`, from here on. The publication
 *   references the columns by name: renaming one breaks replication, and the
 *   connector either fails or loses the column in silence (data-model.md §7.4).
 *   A rename is four steps across two versions — add, backfill, write to both,
 *   drop later — never one.
 */
export class Initial1758800000000 implements MigrationInterface {
  name = 'Initial1758800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ⚠ `show` IS QUOTED, AND IT HAS TO BE READ AS DELIBERATE. `SHOW` is a
    //   Postgres command word; it is unreserved, so `CREATE TABLE show` happens
    //   to parse today. Quoting costs nothing and removes the class of failure
    //   entirely — and TypeORM quotes the identifier in every statement it
    //   generates from `@Entity('show')`, so an unquoted table here would be the
    //   one spelling that differs from all the others.
    //
    // No `citext` extension, unlike identity: nothing here is unique
    // case-insensitively. A show's per-language slugs would need it, and they are
    // not in this slice (see show.entity.ts).
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

    // The catalogue is browsed BY CHANNEL on every studio screen, and a channel
    // has tens of shows where the table has all of them.
    await queryRunner.query('CREATE INDEX idx_show_channel_id ON "show" (channel_id)');

    await queryRunner.query(outboxTableDdl());

    // ⚠ NOT PART OF `outboxTableDdl()`, AND IT SHOULD BE. Identity created this
    //   index by hand in its own initial migration; the shared helper emits the
    //   columns and the constraints but not the index, so every service has to
    //   remember it separately — which is how one of them will not. Recorded in
    //   HANDOVER.md as belonging in `@arthome-platform/messaging`.
    //
    //   Used by the cleanup job only: the application never reads this table,
    //   because CDC reads the write-ahead log (§7.5 retention).
    await queryRunner.query(
      'CREATE INDEX idx_outbox_event_created_at ON outbox_event (created_at)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE outbox_event');
    await queryRunner.query('DROP TABLE "show"');
  }
}
