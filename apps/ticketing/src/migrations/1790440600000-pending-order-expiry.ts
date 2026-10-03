import type { MigrationInterface, QueryRunner } from 'typeorm';

import { OrderState } from '@arthome/core';

/**
 * The sweeper's second scan: an order still pending past its expiry with no intent, whose hold went
 *   back while the provider did not answer and whose purchase was never retried.
 */
export class PendingOrderExpiry1790440600000 implements MigrationInterface {
  name = 'PendingOrderExpiry1790440600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX idx_seat_order_pending_expiry ON seat_order (expires_at)
        WHERE state = '${OrderState.PENDING}' AND payment_intent_ref IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX idx_seat_order_pending_expiry');
  }
}
