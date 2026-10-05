import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The publisher's bookkeeping leaves `date_sales` for a table of its own, so it never locks the
 *   row the capacity invariant serialises on (adr-ticketing.md §3). A move counts itself on
 *   `date_sales` in the statement that makes it; the publisher records the count it published.
 *   Neither table is captured by CDC: only `outbox_event` is.
 */
export class AvailabilityPublication1790440100000 implements MigrationInterface {
  name = 'AvailabilityPublication1790440100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE date_sales ADD COLUMN availability_moves bigint NOT NULL DEFAULT 0',
    );
    await queryRunner.query(`
      CREATE TABLE date_availability_publication (
        date_id            uuid        PRIMARY KEY REFERENCES date_sales (date_id),
        published_moves    bigint      NOT NULL DEFAULT 0,
        published_at       timestamptz NULL,
        published_sold_out boolean     NULL
      )
    `);
    // A date marked and not yet published stays due: one move ahead of what was published.
    await queryRunner.query(`
      INSERT INTO date_availability_publication (date_id, published_at, published_sold_out)
      SELECT date_id, availability_published_at, availability_published_sold_out FROM date_sales
    `);
    await queryRunner.query(
      'UPDATE date_sales SET availability_moves = 1 WHERE availability_dirty_since IS NOT NULL',
    );
    await queryRunner.query('DROP INDEX idx_date_sales_availability_dirty');
    await queryRunner.query(`
      ALTER TABLE date_sales
        DROP COLUMN availability_dirty_since,
        DROP COLUMN availability_published_at,
        DROP COLUMN availability_published_sold_out
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE date_sales
        ADD COLUMN availability_dirty_since        timestamptz NULL,
        ADD COLUMN availability_published_at       timestamptz NULL,
        ADD COLUMN availability_published_sold_out boolean     NULL
    `);
    await queryRunner.query(`
      UPDATE date_sales AS sales
         SET availability_published_at = publication.published_at,
             availability_published_sold_out = publication.published_sold_out,
             availability_dirty_since = CASE
               WHEN sales.availability_moves > publication.published_moves THEN now()
             END
        FROM date_availability_publication AS publication
       WHERE publication.date_id = sales.date_id
    `);
    await queryRunner.query(`
      CREATE INDEX idx_date_sales_availability_dirty
          ON date_sales (availability_published_at)
       WHERE availability_dirty_since IS NOT NULL
    `);
    await queryRunner.query('DROP TABLE date_availability_publication');
    await queryRunner.query('ALTER TABLE date_sales DROP COLUMN availability_moves');
  }
}
