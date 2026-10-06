import type { MigrationInterface, QueryRunner } from 'typeorm';

import { DateOutcome, RefundReason, SeatHoldState, SeatState } from '@arthome/core';

const UNSEATED_REFUND_REASONS = [
  RefundReason.HOLD_EXPIRED_CAPACITY_LOST,
  RefundReason.DATE_CANCELLED,
].map((reason) => `'${reason}'`);

const OUTCOMES_SETTLED = [DateOutcome.CANCELLED, DateOutcome.INTERRUPTED].map(
  (outcome) => `'${outcome}'`,
);

/**
 * A date's outcomes (HANDOVER §0n): the settlement row the consumer writes once a cancellation or
 *   an interruption is recorded, which the sweeper's pass settles; the credit an interrupted date
 *   issues per paid order, which a credited seat names; and the indexes the pass reads a date's seats and holds by. A date's
 *   own refund and a payment refunded on a cancelled date (D-097) owe no seat, so the one unseated
 *   refund per order held since D-082 covers `date_cancelled` too. The dates already cancelled or
 *   interrupted are settled by the pass's first passes.
 */
export class DateOutcomes1790441400000 implements MigrationInterface {
  name = 'DateOutcomes1790441400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE date_outcome_settlement (
        date_id           uuid        PRIMARY KEY REFERENCES date_sales (date_id),
        outcome           text        NOT NULL,
        recorded_at       timestamptz NOT NULL,
        traceparent       text        NULL,
        waitlist_ended_at timestamptz NULL,
        settled_at        timestamptz NULL,
        failed_at         timestamptz NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_date_outcome_settlement_due ON date_outcome_settlement (recorded_at)
        WHERE settled_at IS NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE credit (
        id            uuid        PRIMARY KEY,
        account_id    uuid        NOT NULL,
        channel_id    text        NOT NULL,
        order_id      uuid        NOT NULL REFERENCES seat_order (id),
        amount_minor  bigint      NOT NULL CHECK (amount_minor > 0),
        currency_code text        NOT NULL,
        origin        text        NOT NULL,
        origin_ref    uuid        NULL,
        state         text        NOT NULL,
        expires_at    timestamptz NOT NULL,
        version       integer     NOT NULL CHECK (version >= 1),
        created_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_credit_order_origin UNIQUE (order_id, origin)
      )
    `);

    await queryRunner.query(
      'ALTER TABLE seat ADD CONSTRAINT seat_credit_fkey FOREIGN KEY (credit_id) REFERENCES credit (id)',
    );
    await queryRunner.query(
      'ALTER TABLE seat_order ADD COLUMN outcome_settled_at timestamptz NULL',
    );
    await queryRunner.query(
      `CREATE INDEX idx_seat_date_active ON seat (date_id) WHERE state = '${SeatState.ACTIVE}'`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_seat_hold_active_date ON seat_hold (date_id)
        WHERE state = '${SeatHoldState.ACTIVE}'`,
    );

    await queryRunner.query('DROP INDEX uq_order_refund_unseated');
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_order_refund_unseated ON order_refund (order_id)
        WHERE seat_id IS NULL AND reason IN (${UNSEATED_REFUND_REASONS.join(', ')})`,
    );

    await queryRunner.query(`
      INSERT INTO date_outcome_settlement (date_id, outcome, recorded_at)
      SELECT date_id, outcome, outcome_stated_at
        FROM date_sales
       WHERE outcome IN (${OUTCOMES_SETTLED.join(', ')})
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX uq_order_refund_unseated');
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_order_refund_unseated ON order_refund (order_id)
        WHERE reason = '${RefundReason.HOLD_EXPIRED_CAPACITY_LOST}'`,
    );
    await queryRunner.query('DROP INDEX idx_seat_hold_active_date');
    await queryRunner.query('DROP INDEX idx_seat_date_active');
    await queryRunner.query('ALTER TABLE seat_order DROP COLUMN outcome_settled_at');
    await queryRunner.query('ALTER TABLE seat DROP CONSTRAINT seat_credit_fkey');
    await queryRunner.query('DROP TABLE credit');
    await queryRunner.query('DROP TABLE date_outcome_settlement');
  }
}
