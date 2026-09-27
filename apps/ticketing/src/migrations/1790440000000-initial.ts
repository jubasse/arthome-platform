import { idempotencyRecordTableDdl } from '@arthome-platform/http-edge';
import { outboxTableDdl, processedMessageTableDdl } from '@arthome-platform/messaging';
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The outbox, the processed-message ledger and the idempotency store come from their libraries,
 *   constraints included: a copy here would drift from the one every other service runs.
 * `date_sales` holds the capacity invariant twice: the hot decrement's WHERE (adr-ticketing.md §3)
 *   is the rule, and the CHECKs refuse a counter any other write would push past it.
 */
export class Initial1790440000000 implements MigrationInterface {
  name = 'Initial1790440000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE date_sales (
        date_id                         uuid        PRIMARY KEY,
        channel_id                      text        NOT NULL,
        capacity_total                  integer     NOT NULL CHECK (capacity_total >= 0),
        capacity_tiers                  jsonb       NOT NULL,
        seats_available                 integer     NOT NULL CHECK (seats_available >= 0),
        seats_sold                      integer     NOT NULL CHECK (seats_sold >= 0),
        waitlist_count                  integer     NOT NULL CHECK (waitlist_count >= 0),
        price_tiers                     jsonb       NOT NULL,
        prices_locked_at                timestamptz NULL,
        sales_closed_at                 timestamptz NULL,
        on_sale                         boolean     GENERATED ALWAYS AS
                                          (prices_locked_at IS NOT NULL AND sales_closed_at IS NULL)
                                          STORED,
        starts_at                       timestamptz NULL,
        schedule_stated_at              timestamptz NULL,
        outcome                         text        NULL,
        outcome_stated_at               timestamptz NULL,
        version                         integer     NOT NULL,
        availability_dirty_since        timestamptz NULL,
        availability_published_at       timestamptz NULL,
        availability_published_sold_out boolean     NULL,
        created_at                      timestamptz NOT NULL DEFAULT now(),
        updated_at                      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT date_sales_seats_within_capacity
          CHECK (seats_available + seats_sold <= capacity_total)
      )
    `);

    // The publisher's scan: only the dates moved since their last publication.
    await queryRunner.query(`
      CREATE INDEX idx_date_sales_availability_dirty
          ON date_sales (availability_published_at)
       WHERE availability_dirty_since IS NOT NULL
    `);

    await queryRunner.query(processedMessageTableDdl());
    await queryRunner.query(idempotencyRecordTableDdl());

    await queryRunner.query(outboxTableDdl());
    // Not part of `outboxTableDdl()`: the retention purge's scan (AGENTS.md).
    await queryRunner.query(
      'CREATE INDEX idx_outbox_event_created_at ON outbox_event (created_at)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE outbox_event');
    await queryRunner.query('DROP TABLE idempotency_record');
    await queryRunner.query('DROP TABLE processed_message');
    await queryRunner.query('DROP TABLE date_sales');
  }
}
