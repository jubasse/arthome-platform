import type { MigrationInterface, QueryRunner } from 'typeorm';

import { OrderState, SeatHoldState } from '@arthome/core';

/**
 * A purchase's three tables (data-model.md §3.2, §3.3). `seat_order` binds the purchase's
 *   idempotency key to the order it created (adr-ticketing.md §2), so a replay after a crash between
 *   the two transactions finds the order and resumes it, and keeps the answer it served. A seat
 *   exists only from payment (D-077). None of the three is captured by CDC: only `outbox_event` is.
 */
export class HoldsAndOrders1790440500000 implements MigrationInterface {
  name = 'HoldsAndOrders1790440500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE seat_hold (
        id          uuid        PRIMARY KEY,
        date_id     uuid        NOT NULL REFERENCES date_sales (date_id),
        account_id  uuid        NULL,
        profile_id  uuid        NULL,
        tier        text        NOT NULL,
        quantity    integer     NOT NULL CHECK (quantity > 0),
        origin      text        NOT NULL,
        origin_ref  uuid        NOT NULL,
        expires_at  timestamptz NOT NULL,
        state       text        NOT NULL,
        version     integer     NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    // The sweeper's scan (adr-ticketing.md §6): the active holds, by expiry.
    await queryRunner.query(
      `CREATE INDEX idx_seat_hold_active_expiry ON seat_hold (expires_at)
        WHERE state = '${SeatHoldState.ACTIVE}'`,
    );

    await queryRunner.query('CREATE SEQUENCE seat_order_reference');
    await queryRunner.query(`
      CREATE TABLE seat_order (
        id                    uuid        PRIMARY KEY,
        reference             text        NOT NULL UNIQUE,
        idempotency_key       uuid        NOT NULL,
        account_id            uuid        NULL,
        fingerprint           text        NOT NULL,
        date_id               uuid        NOT NULL REFERENCES date_sales (date_id),
        channel_id            text        NOT NULL,
        profile_id            uuid        NULL,
        tier                  text        NOT NULL,
        quantity              integer     NOT NULL CHECK (quantity > 0),
        currency_code         text        NOT NULL,
        unit_price_minor      bigint      NOT NULL,
        tier_total_minor      bigint      NOT NULL,
        service_fee_minor     bigint      NOT NULL,
        discount_minor        bigint      NOT NULL,
        total_minor           bigint      NOT NULL CHECK (total_minor >= 0),
        declared_tax_location jsonb       NULL,
        hold_id               uuid        NOT NULL
                                REFERENCES seat_hold (id) DEFERRABLE INITIALLY DEFERRED,
        expires_at            timestamptz NOT NULL,
        state                 text        NOT NULL,
        payment_intent_ref    text        NULL,
        client_secret         text        NULL,
        next_action           jsonb       NULL,
        failure_code          text        NULL,
        decline_code          text        NULL,
        refund_reason         text        NULL,
        refund_owed_at        timestamptz NULL,
        refund_ref            text        NULL,
        refunded_at           timestamptz NULL,
        intent_cancel_owed_at timestamptz NULL,
        placed_at             timestamptz NOT NULL,
        paid_at               timestamptz NULL,
        answer_status         integer     NULL,
        answer_body           json        NULL,
        version               integer     NOT NULL,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT seat_order_idempotency UNIQUE NULLS NOT DISTINCT (account_id, idempotency_key)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_seat_order_intent ON seat_order (payment_intent_ref)
        WHERE payment_intent_ref IS NOT NULL`,
    );
    // The payment worker's two scans: a refund owed, an intent to cancel.
    await queryRunner.query(
      `CREATE INDEX idx_seat_order_refund_owed ON seat_order (refund_owed_at)
        WHERE refund_owed_at IS NOT NULL AND state <> '${OrderState.REFUNDED}'`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_seat_order_intent_cancel_owed ON seat_order (intent_cancel_owed_at)
        WHERE intent_cancel_owed_at IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE seat (
        id              uuid        PRIMARY KEY,
        order_id        uuid        NOT NULL REFERENCES seat_order (id),
        date_id         uuid        NOT NULL,
        account_id      uuid        NULL,
        profile_id      uuid        NULL,
        tier            text        NOT NULL,
        seat_code       text        NOT NULL UNIQUE,
        state           text        NOT NULL,
        cancel_deadline timestamptz NULL,
        activated_at    timestamptz NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_seat_order_id ON seat (order_id)');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE seat');
    await queryRunner.query('DROP TABLE seat_order');
    await queryRunner.query('DROP SEQUENCE seat_order_reference');
    await queryRunner.query('DROP TABLE seat_hold');
  }
}
