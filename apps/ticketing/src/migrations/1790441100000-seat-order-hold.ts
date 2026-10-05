import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The expiry pass joins each due hold to its order by `hold_id`: without this, every second a hold
 *   is due, it read every order ever placed (the correctness review's plan: a sequential scan of
 *   `seat_order` for 851 of its 911 cost over 20,000 orders).
 */
export class SeatOrderHold1790441100000 implements MigrationInterface {
  name = 'SeatOrderHold1790441100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE INDEX idx_seat_order_hold ON seat_order (hold_id)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX idx_seat_order_hold');
  }
}
