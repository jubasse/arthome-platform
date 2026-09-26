import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A channel's public face, for the date documents that name its artist. */
export class ArtistProjection1790430200000 implements MigrationInterface {
  name = 'ArtistProjection1790430200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE artist_projection (
        channel_id text PRIMARY KEY,
        artist_id text NOT NULL,
        public_name text NOT NULL,
        version bigint NOT NULL
      )
    `);
    // A face change recomposes every public date of the channel, found by the scheduled facts.
    await queryRunner.query(
      "CREATE INDEX date_projection_channel_id ON date_projection ((scheduled->>'channel_id'))",
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX date_projection_channel_id');
    await queryRunner.query('DROP TABLE artist_projection');
  }
}
