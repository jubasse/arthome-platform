import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * When a sale ends by time (`seatSalesEndAt`), and the sweeper's scan for the sales past it: the
 *   publisher's pass reads every sale on sale, and stays bounded only while sales end.
 */
export class SalesEnd1790440800000 implements MigrationInterface {
  name = 'SalesEnd1790440800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE date_sales ADD COLUMN sales_end_at timestamptz NULL');
    await queryRunner.query(
      `CREATE INDEX idx_date_sales_on_sale_end ON date_sales (sales_end_at)
        WHERE on_sale AND sales_end_at IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX idx_date_sales_on_sale_end');
    await queryRunner.query('ALTER TABLE date_sales DROP COLUMN sales_end_at');
  }
}
