import type { MigrationInterface, QueryRunner } from 'typeorm';

import { SeatState } from '@arthome/core';

/**
 * A seat leaves `active` (PT2): cancelled with the refund it is owed, refunded once that refund is
 *   made, or credited (PT1, whose `credit` table takes `credit_id`'s foreign key), its share of the
 *   credit nothing when the money left is below the seats credited. No backfill: every seat is
 *   active. The inbox keeps what a refund webhook reports, the provider's reference
 *   and everything refunded on the payment so far, and a refund the call a webhook asks again.
 */
export class SeatStates1790441350000 implements MigrationInterface {
  name = 'SeatStates1790441350000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE seat
        ADD COLUMN ended_at            timestamptz NULL,
        ADD COLUMN cancel_reason       text        NULL,
        ADD COLUMN refund_id           uuid        NULL REFERENCES order_refund (id),
        ADD COLUMN refund_amount_minor bigint      NULL CHECK (refund_amount_minor > 0),
        ADD COLUMN credit_id           uuid        NULL,
        ADD COLUMN credit_amount_minor bigint      NULL CHECK (credit_amount_minor >= 0),
        ADD CONSTRAINT seat_ended_unless_active
          CHECK ((state = '${SeatState.ACTIVE}') = (ended_at IS NULL)),
        ADD CONSTRAINT seat_refund_amount_with_refund
          CHECK ((refund_id IS NULL) = (refund_amount_minor IS NULL)),
        ADD CONSTRAINT seat_credit_amount_with_credit
          CHECK ((credit_id IS NULL) = (credit_amount_minor IS NULL))
    `);
    await queryRunner.query(`
      ALTER TABLE stripe_event_inbox
        ADD COLUMN refund_ref                    text   NULL,
        ADD COLUMN amount_refunded_minor         bigint NULL,
        ADD COLUMN amount_refunded_currency_code text   NULL
    `);
    await queryRunner.query('ALTER TABLE order_refund ADD COLUMN rerun_asked_at timestamptz NULL');
    await queryRunner.query(
      `CREATE INDEX idx_order_refund_rerun_asked ON order_refund (rerun_asked_at)
        WHERE rerun_asked_at IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX idx_order_refund_rerun_asked');
    await queryRunner.query('ALTER TABLE order_refund DROP COLUMN rerun_asked_at');
    await queryRunner.query(`
      ALTER TABLE stripe_event_inbox
        DROP COLUMN amount_refunded_currency_code,
        DROP COLUMN amount_refunded_minor,
        DROP COLUMN refund_ref
    `);
    await queryRunner.query(`
      ALTER TABLE seat
        DROP CONSTRAINT seat_credit_amount_with_credit,
        DROP CONSTRAINT seat_refund_amount_with_refund,
        DROP CONSTRAINT seat_ended_unless_active,
        DROP COLUMN credit_amount_minor,
        DROP COLUMN credit_id,
        DROP COLUMN refund_amount_minor,
        DROP COLUMN refund_id,
        DROP COLUMN cancel_reason,
        DROP COLUMN ended_at
    `);
  }
}
