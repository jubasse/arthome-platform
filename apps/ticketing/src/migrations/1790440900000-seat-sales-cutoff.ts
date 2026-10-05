import type { MigrationInterface, QueryRunner } from 'typeorm';

import { SEAT_SALES_CUTOFF_MINUTES_AFTER_START } from '@arthome/core';

/**
 * D-089 for the dates scheduled before it: each sale's end by time, its start plus the cutoff, as
 *   `recordSchedule` now writes it. A sale already past it is closed by the sweeper's next pass.
 */
export class SeatSalesCutoff1790440900000 implements MigrationInterface {
  name = 'SeatSalesCutoff1790440900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE date_sales SET sales_end_at = starts_at + make_interval(mins => $1)
        WHERE starts_at IS NOT NULL`,
      [SEAT_SALES_CUTOFF_MINUTES_AFTER_START],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('UPDATE date_sales SET sales_end_at = NULL');
  }
}
