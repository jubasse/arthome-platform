import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Initial1758700100000 implements MigrationInterface {
  name = 'Initial1758700100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE processed_message (
        id           uuid        PRIMARY KEY,
        topic        text        NOT NULL,
        processed_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE welcome_email (
        account_id  uuid        PRIMARY KEY,
        locale      text        NOT NULL,
        country     text        NOT NULL,
        traceparent text        NULL,
        queued_at   timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE welcome_email');
    await queryRunner.query('DROP TABLE processed_message');
  }
}
