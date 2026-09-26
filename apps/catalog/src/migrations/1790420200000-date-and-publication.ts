import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * data-model.md §2.2 and §2.3: two aggregates, one publication per date. `date` is quoted like
 * `show`: it is a type name in Postgres, and TypeORM quotes every identifier it generates.
 */
export class DateAndPublication1790420200000 implements MigrationInterface {
  name = 'DateAndPublication1790420200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "date" (
        id                  uuid        PRIMARY KEY,
        show_id             uuid        NOT NULL REFERENCES "show" (id),
        venue_id            uuid        NOT NULL REFERENCES venue (id),
        channel_id          text        NOT NULL,
        starts_at           timestamptz NOT NULL,
        runtime_min         integer     NOT NULL,
        replay_policy       text        NOT NULL,
        replay_window_hours integer     NULL,
        rights              jsonb       NOT NULL,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_date_channel_id ON "date" (channel_id)');
    await queryRunner.query('CREATE INDEX idx_date_show_id ON "date" (show_id)');

    await queryRunner.query(`
      CREATE TABLE publication (
        date_id          uuid        PRIMARY KEY REFERENCES "date" (id),
        channel_id       text        NOT NULL,
        state            text        NOT NULL,
        version          integer     NOT NULL,
        published_at     timestamptz NULL,
        prices_locked_at timestamptz NULL,
        replay_online_at timestamptz NULL,
        updated_at       timestamptz NOT NULL DEFAULT now()
      )
    `);

    // The projected half of the checklist, one row per fact another context reported.
    await queryRunner.query(`
      CREATE TABLE publication_checklist_fact (
        date_id    uuid        NOT NULL REFERENCES "date" (id),
        item       text        NOT NULL,
        satisfied  boolean     NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (date_id, item)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE publication_checklist_fact');
    await queryRunner.query('DROP TABLE publication');
    await queryRunner.query('DROP TABLE "date"');
  }
}
