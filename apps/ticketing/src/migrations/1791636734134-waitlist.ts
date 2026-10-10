import type { MigrationInterface, QueryRunner } from 'typeorm';

import { WAITLIST_ENTRY_STATES, WaitlistEntryState } from '@arthome/core';

const STATES = WAITLIST_ENTRY_STATES.map((state) => `'${state}'`).join(', ');
const ON_LIST = [WaitlistEntryState.WAITING, WaitlistEntryState.NOTIFIED]
  .map((state) => `'${state}'`)
  .join(', ');

/**
 * The waiting list and its priority window (HANDOVER §0p): one entry per account and date, the
 *   pool a tier opening sets aside for the notified accounts beside the public seats, the window's
 *   end the sweeper reads, and the pool seats a hold drew, which go back to the pool while the
 *   window is open. No backfill: no list existed, so every count is 0 and every pool empty.
 */
export class Waitlist1791636734134 implements MigrationInterface {
  name = 'Waitlist1791636734134';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE waitlist_entry (
        id          uuid        PRIMARY KEY,
        date_id     uuid        NOT NULL REFERENCES date_sales (date_id),
        account_id  uuid        NOT NULL,
        state       text        NOT NULL CHECK (state IN (${STATES})),
        joined_at   timestamptz NOT NULL,
        notified_at timestamptz NULL,
        ended_at    timestamptz NULL,
        version     integer     NOT NULL CHECK (version >= 1),
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT waitlist_entry_one_per_account UNIQUE (date_id, account_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_waitlist_entry_on_list ON waitlist_entry (date_id)
        WHERE state IN (${ON_LIST})`,
    );
    await queryRunner.query(`
      ALTER TABLE date_sales
        ADD COLUMN priority_pool_seats integer     NOT NULL DEFAULT 0
          CHECK (priority_pool_seats >= 0),
        ADD COLUMN priority_until      timestamptz NULL,
        DROP CONSTRAINT date_sales_seats_within_capacity,
        ADD CONSTRAINT date_sales_seats_within_capacity
          CHECK (seats_available + priority_pool_seats + seats_sold <= capacity_total),
        ADD CONSTRAINT date_sales_pool_within_window
          CHECK (priority_pool_seats = 0 OR priority_until IS NOT NULL)
    `);
    await queryRunner.query(
      `CREATE INDEX idx_date_sales_priority_until ON date_sales (priority_until)
        WHERE priority_until IS NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE seat_hold
        ADD COLUMN pool_seats integer NOT NULL DEFAULT 0
          CHECK (pool_seats BETWEEN 0 AND quantity)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE seat_hold DROP COLUMN pool_seats');
    await queryRunner.query('DROP INDEX idx_date_sales_priority_until');
    await queryRunner.query(`
      ALTER TABLE date_sales
        DROP CONSTRAINT date_sales_pool_within_window,
        DROP CONSTRAINT date_sales_seats_within_capacity,
        ADD CONSTRAINT date_sales_seats_within_capacity
          CHECK (seats_available + seats_sold <= capacity_total),
        DROP COLUMN priority_until,
        DROP COLUMN priority_pool_seats
    `);
    await queryRunner.query('DROP TABLE waitlist_entry');
  }
}
