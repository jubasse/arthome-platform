import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bounds the publisher's pass to what can still owe a publication: the sales on sale, and the
 *   closings not yet published, each behind a partial index. The history of closed sales, published
 *   once and for all, is no longer read every second.
 */
export class AvailabilityScan1790440400000 implements MigrationInterface {
  name = 'AvailabilityScan1790440400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE date_availability_publication ADD COLUMN closing_due boolean NOT NULL DEFAULT false',
    );
    await queryRunner.query(`
      UPDATE date_availability_publication AS publication
         SET closing_due = true
        FROM date_sales AS sales
       WHERE sales.date_id = publication.date_id
         AND sales.sales_closed_at IS NOT NULL
         AND sales.availability_moves > publication.published_moves
    `);
    await queryRunner.query(
      'CREATE INDEX idx_date_sales_on_sale ON date_sales (date_id) WHERE on_sale',
    );
    await queryRunner.query(`
      CREATE INDEX idx_date_availability_publication_closing_due
          ON date_availability_publication (date_id)
       WHERE closing_due
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX idx_date_availability_publication_closing_due');
    await queryRunner.query('DROP INDEX idx_date_sales_on_sale');
    await queryRunner.query('ALTER TABLE date_availability_publication DROP COLUMN closing_due');
  }
}
