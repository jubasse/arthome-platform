import type { MigrationInterface, QueryRunner } from 'typeorm';

import { RefundReason } from '@arthome/core';

/**
 * One refund of a payment that found no seat (D-082) per order, held by the database as well as by
 *   `SeatOrder.oweUnseatedPaymentBack`: since core's `refundIdempotencyKey` its key is the refund's
 *   own, so the key's uniqueness no longer stands for it (the review's C-N2).
 */
export class OneUnseatedRefundPerOrder1790441300000 implements MigrationInterface {
  name = 'OneUnseatedRefundPerOrder1790441300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_order_refund_unseated ON order_refund (order_id)
        WHERE reason = '${RefundReason.HOLD_EXPIRED_CAPACITY_LOST}'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX uq_order_refund_unseated');
  }
}
