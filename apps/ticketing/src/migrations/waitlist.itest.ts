import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PriceTier, SeatHoldOrigin, SeatHoldState } from '@arthome/core';

import { Waitlist1791636734134 } from './1791636734134-waitlist.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';

/**
 * `Waitlist1791636734134` on a database that already holds dates and holds: no backfill, every
 *   pool empty, no window, every count 0, and the capacity CHECK now counting the pool.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const DATE_ID = '01a0fc70-0000-7000-8000-000000000001';
const HOLD_ID = '01a0fc70-0000-7000-8000-0000000000b1';
const ORDER_ID = '01a0fc70-0000-7000-8000-0000000000a1';

let stack: StartedStack;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
}, STARTUP_MS);

afterAll(async () => {
  await stack?.stop();
});

describe('the waiting list migration', () => {
  it(
    'leaves every date with no pool, no window and no list, and every hold with no pool seat',
    async () => {
      const database = await createDatabase(stack.postgres, 'ticketing_waitlist_migration');
      const { entities, migrations } = TICKETING_SCHEMA;
      if (!Array.isArray(migrations)) throw new Error('the schema lists its migrations');
      const before = await applyMigrations(database, {
        entities,
        migrations: migrations.filter((migration) => migration !== Waitlist1791636734134),
      });
      try {
        await before.query(
          `INSERT INTO date_sales (date_id, channel_id, capacity_total, capacity_tiers,
                                   seats_available, seats_sold, waitlist_count, price_tiers,
                                   prices_locked_at, version)
           VALUES ($1, 'channel-waitlist', 10, '[]', 6, 2, 0, '[]', now(), 3)`,
          [DATE_ID],
        );
        await before.query(
          `INSERT INTO seat_hold (id, date_id, tier, quantity, origin, origin_ref, expires_at,
                                  state, version)
           VALUES ($1, $2, $4, 2, $5, $3, now(), $6, 1)`,
          [
            HOLD_ID,
            DATE_ID,
            ORDER_ID,
            PriceTier.FULL,
            SeatHoldOrigin.CHECKOUT,
            SeatHoldState.ACTIVE,
          ],
        );
      } finally {
        await before.destroy();
      }

      const after = await applyMigrations(database, TICKETING_SCHEMA);
      try {
        expect(
          await after.query(
            `SELECT seats_available, priority_pool_seats, priority_until, waitlist_count
               FROM date_sales`,
          ),
        ).toEqual([
          { seats_available: 6, priority_pool_seats: 0, priority_until: null, waitlist_count: 0 },
        ]);
        expect(await after.query('SELECT pool_seats FROM seat_hold')).toEqual([{ pool_seats: 0 }]);
        expect(await after.query('SELECT count(*)::int AS entries FROM waitlist_entry')).toEqual([
          { entries: 0 },
        ]);
        await expect(
          after.query(
            `UPDATE date_sales SET priority_pool_seats = 3, priority_until = now()
              WHERE date_id = $1`,
            [DATE_ID],
          ),
        ).rejects.toThrow(/date_sales_seats_within_capacity/);
        await expect(
          after.query('UPDATE date_sales SET priority_pool_seats = 1 WHERE date_id = $1', [
            DATE_ID,
          ]),
        ).rejects.toThrow(/date_sales_pool_within_window/);
        await expect(
          after.query('UPDATE seat_hold SET pool_seats = 3 WHERE id = $1', [HOLD_ID]),
        ).rejects.toThrow(/check/);
      } finally {
        await after.destroy();
      }
    },
    CASE_MS,
  );
});
