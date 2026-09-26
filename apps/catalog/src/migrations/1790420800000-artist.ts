import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The Artist aggregate, and the artist a public date card names. */
export class Artist1790420800000 implements MigrationInterface {
  name = 'Artist1790420800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE artist (
        id uuid PRIMARY KEY,
        channel_id text NOT NULL,
        public_name text NOT NULL,
        slug text NOT NULL,
        biography jsonb NOT NULL,
        category_id text NOT NULL,
        version integer NOT NULL,
        joined_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX artist_channel_id ON artist (channel_id)');
    // Named so the error filter maps it to artist.slug_taken, and no `date_slug_*` index with it.
    await queryRunner.query('CREATE UNIQUE INDEX artist_slug ON artist (slug)');
    await queryRunner.query('ALTER TABLE date_detail_public ADD COLUMN artist_name text NULL');
    await queryRunner.query(
      'CREATE INDEX date_detail_public_channel_id ON date_detail_public (channel_id)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX date_detail_public_channel_id');
    await queryRunner.query('ALTER TABLE date_detail_public DROP COLUMN artist_name');
    await queryRunner.query('DROP TABLE artist');
  }
}
