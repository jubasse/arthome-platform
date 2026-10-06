import type { MigrationInterface, QueryRunner } from 'typeorm';

import { OrderState } from '@arthome/core';

/**
 * The provider calls move to the worker's queues (HANDOVER §0m). A refund becomes a row of its own,
 *   several per order, the relay's `enqueued_at` beside it; each D-082 refund already owed keeps
 *   the key the provider may have seen, `refund:{orderId}`, and is enqueued by the relay's first
 *   pass when still owed. An intent's cancellation stays on its order, its attempts the queue's.
 */
export class ProviderCallQueues1790441200000 implements MigrationInterface {
  name = 'ProviderCallQueues1790441200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE order_refund (
        id              uuid        PRIMARY KEY,
        order_id        uuid        NOT NULL REFERENCES seat_order (id),
        seat_id         uuid        NULL REFERENCES seat (id),
        amount_minor    bigint      NOT NULL CHECK (amount_minor > 0),
        currency_code   text        NOT NULL,
        reason          text        NOT NULL,
        idempotency_key text        NOT NULL UNIQUE,
        owed_at         timestamptz NOT NULL,
        traceparent     text        NULL,
        enqueued_at     timestamptz NULL,
        refund_ref      text        NULL,
        refunded_at     timestamptz NULL,
        dead_at         timestamptz NULL,
        created_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_order_refund_order ON order_refund (order_id)');
    await queryRunner.query(
      `CREATE INDEX idx_order_refund_due ON order_refund (enqueued_at NULLS FIRST, owed_at)
        WHERE refunded_at IS NULL AND dead_at IS NULL`,
    );
    await queryRunner.query(`
      INSERT INTO order_refund (id, order_id, amount_minor, currency_code, reason, idempotency_key,
                                owed_at, traceparent, refund_ref, refunded_at, dead_at)
      SELECT uuidv7(), id, total_minor, currency_code, refund_reason, 'refund:' || id,
             refund_owed_at, refund_traceparent, refund_ref, refunded_at, refund_dead_at
        FROM seat_order
       WHERE refund_owed_at IS NOT NULL
    `);

    await queryRunner.query('DROP INDEX idx_seat_order_refund_due');
    await queryRunner.query('DROP INDEX idx_seat_order_intent_cancel_due');
    await queryRunner.query(`
      ALTER TABLE seat_order
        DROP COLUMN refund_reason,
        DROP COLUMN refund_owed_at,
        DROP COLUMN refund_ref,
        DROP COLUMN refunded_at,
        DROP COLUMN refund_attempts,
        DROP COLUMN refund_next_attempt_at,
        DROP COLUMN refund_dead_at,
        DROP COLUMN refund_traceparent,
        DROP COLUMN intent_cancel_attempts,
        DROP COLUMN intent_cancel_next_attempt_at,
        ADD COLUMN intent_cancel_enqueued_at timestamptz NULL
    `);
    await queryRunner.query(
      `CREATE INDEX idx_seat_order_intent_cancel_due
          ON seat_order (intent_cancel_enqueued_at NULLS FIRST, intent_cancel_owed_at)
       WHERE intent_cancel_owed_at IS NOT NULL AND intent_cancel_dead_at IS NULL`,
    );
  }

  /** Each order's first refund back on its row: lossless while no order owes a second. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX idx_seat_order_intent_cancel_due');
    await queryRunner.query(`
      ALTER TABLE seat_order
        DROP COLUMN intent_cancel_enqueued_at,
        ADD COLUMN refund_reason                 text        NULL,
        ADD COLUMN refund_owed_at                timestamptz NULL,
        ADD COLUMN refund_ref                    text        NULL,
        ADD COLUMN refunded_at                   timestamptz NULL,
        ADD COLUMN refund_attempts               integer     NOT NULL DEFAULT 0,
        ADD COLUMN refund_next_attempt_at        timestamptz NULL,
        ADD COLUMN refund_dead_at                timestamptz NULL,
        ADD COLUMN refund_traceparent            text        NULL,
        ADD COLUMN intent_cancel_attempts        integer     NOT NULL DEFAULT 0,
        ADD COLUMN intent_cancel_next_attempt_at timestamptz NULL
    `);
    await queryRunner.query(`
      UPDATE seat_order AS placed
         SET refund_reason = first.reason, refund_owed_at = first.owed_at,
             refund_ref = first.refund_ref, refunded_at = first.refunded_at,
             refund_dead_at = first.dead_at, refund_traceparent = first.traceparent
        FROM (SELECT DISTINCT ON (order_id) * FROM order_refund ORDER BY order_id, owed_at) AS first
       WHERE placed.id = first.order_id
    `);
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
    await queryRunner.query('DROP TABLE order_refund');
  }
}
