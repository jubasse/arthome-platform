import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * adr-ticketing.md §8's inbox, under its name there: a webhook is recorded, unique on the
 *   provider's event id, answered at once, and applied later by the payment worker. It keeps the
 *   signed bytes, so a row that cannot be applied is its own dead letter (adr-payments.md §7.4).
 */
export class PaymentEventInbox1790440700000 implements MigrationInterface {
  name = 'PaymentEventInbox1790440700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE stripe_event_inbox (
        event_id     text        PRIMARY KEY,
        kind         text        NOT NULL,
        intent_ref   text        NULL,
        order_id     uuid        NULL,
        decline_code text        NULL,
        occurred_at  timestamptz NOT NULL,
        payload      bytea       NOT NULL,
        traceparent  text        NULL,
        received_at  timestamptz NOT NULL DEFAULT now(),
        applied_at   timestamptz NULL,
        attempts     integer     NOT NULL DEFAULT 0,
        retry_at     timestamptz NULL,
        dead_at      timestamptz NULL,
        last_error   text        NULL
      )
    `);
    // The worker's scan: what is neither applied nor given up on.
    await queryRunner.query(
      `CREATE INDEX idx_stripe_event_inbox_due ON stripe_event_inbox (received_at)
        WHERE applied_at IS NULL AND dead_at IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE stripe_event_inbox');
  }
}
