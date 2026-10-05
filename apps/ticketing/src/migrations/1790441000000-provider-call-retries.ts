import type { MigrationInterface, QueryRunner } from 'typeorm';

import { OrderState } from '@arthome/core';

/**
 * The attempts of the calls the payment worker owes the provider, beside the facts they serve
 *   (`refund_owed_at`, `intent_cancel_owed_at`): their count, when the next is due, when they were
 *   given up. And the trace a refund was owed under, for its `order.refunded`.
 */
export class ProviderCallRetries1790441000000 implements MigrationInterface {
  name = 'ProviderCallRetries1790441000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE seat_order
        ADD COLUMN refund_attempts               integer     NOT NULL DEFAULT 0,
        ADD COLUMN refund_next_attempt_at        timestamptz NULL,
        ADD COLUMN refund_dead_at                timestamptz NULL,
        ADD COLUMN refund_traceparent            text        NULL,
        ADD COLUMN intent_cancel_attempts        integer     NOT NULL DEFAULT 0,
        ADD COLUMN intent_cancel_next_attempt_at timestamptz NULL,
        ADD COLUMN intent_cancel_dead_at         timestamptz NULL
    `);
    await queryRunner.query('DROP INDEX idx_seat_order_refund_owed');
    await queryRunner.query('DROP INDEX idx_seat_order_intent_cancel_owed');
    await queryRunner.query(
      `CREATE INDEX idx_seat_order_refund_due
          ON seat_order (refund_next_attempt_at NULLS FIRST, refund_owed_at)
       WHERE refund_owed_at IS NOT NULL AND refund_dead_at IS NULL
         AND state <> '${OrderState.REFUNDED}'`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_seat_order_intent_cancel_due
          ON seat_order (intent_cancel_next_attempt_at NULLS FIRST, intent_cancel_owed_at)
       WHERE intent_cancel_owed_at IS NOT NULL AND intent_cancel_dead_at IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX idx_seat_order_intent_cancel_due');
    await queryRunner.query('DROP INDEX idx_seat_order_refund_due');
    await queryRunner.query(
      `CREATE INDEX idx_seat_order_refund_owed ON seat_order (refund_owed_at)
        WHERE refund_owed_at IS NOT NULL AND state <> '${OrderState.REFUNDED}'`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_seat_order_intent_cancel_owed ON seat_order (intent_cancel_owed_at)
        WHERE intent_cancel_owed_at IS NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE seat_order
        DROP COLUMN refund_attempts,
        DROP COLUMN refund_next_attempt_at,
        DROP COLUMN refund_dead_at,
        DROP COLUMN refund_traceparent,
        DROP COLUMN intent_cancel_attempts,
        DROP COLUMN intent_cancel_next_attempt_at,
        DROP COLUMN intent_cancel_dead_at
    `);
  }
}
