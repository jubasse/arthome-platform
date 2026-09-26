import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ShowCopyAndVenue1790420100000 implements MigrationInterface {
  name = 'ShowCopyAndVenue1790420100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "show"
        ADD COLUMN title    jsonb NOT NULL DEFAULT '{"fr": "", "en": ""}',
        ADD COLUMN synopsis jsonb NOT NULL DEFAULT '{"fr": "", "en": ""}'
    `);

    await queryRunner.query(`
      CREATE TABLE venue (
        id         uuid        PRIMARY KEY,
        name       text        NOT NULL,
        city       text        NOT NULL,
        country    text        NOT NULL,
        time_zone  text        NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE venue');
    await queryRunner.query('ALTER TABLE "show" DROP COLUMN synopsis, DROP COLUMN title');
  }
}
