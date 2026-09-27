import { OutboxEvent, ProcessedMessage } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Initial1790440000000 } from './1790440000000-initial.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';

/**
 * `AvailabilityPublication1790440100000` on a database that already holds dates, as the stack's
 * did: a date marked and not yet published stays due, one published and quiet does not.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const MARKED = '01a0f700-0000-7000-8000-000000000001';
const QUIET = '01a0f700-0000-7000-8000-000000000002';

let stack: StartedStack;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
}, STARTUP_MS);

afterAll(async () => {
  await stack?.stop();
});

describe('the availability publication migration', () => {
  it(
    'moves the marks to the publisher’s table without losing a due date',
    async () => {
      const database = await createDatabase(stack.postgres, 'ticketing_publication_migration');
      const before = await applyMigrations(database, {
        entities: [ProcessedMessage, OutboxEvent],
        migrations: [Initial1790440000000],
      });
      try {
        await before.query(
          `INSERT INTO date_sales (date_id, channel_id, capacity_total, capacity_tiers,
                                   seats_available, seats_sold, waitlist_count, price_tiers,
                                   prices_locked_at, version, availability_dirty_since,
                                   availability_published_at, availability_published_sold_out)
           VALUES ($1, 'channel-migration', 10, '[]', 9, 0, 0, '[]', now(), 3, now(), now(), false),
                  ($2, 'channel-migration', 10, '[]', 10, 0, 0, '[]', now(), 3, NULL, now(), false)`,
          [MARKED, QUIET],
        );
      } finally {
        await before.destroy();
      }

      const after: DataSource = await applyMigrations(database, TICKETING_SCHEMA);
      try {
        const rows = await after.query<{ date_id: string; behind: number; sold_out: boolean }[]>(
          `SELECT date_id, (availability_moves - published_moves)::int AS behind,
                  published_sold_out AS sold_out
             FROM date_sales JOIN date_availability_publication USING (date_id)
            ORDER BY date_id`,
        );
        expect(rows).toEqual([
          { date_id: MARKED, behind: 1, sold_out: false },
          { date_id: QUIET, behind: 0, sold_out: false },
        ]);
      } finally {
        await after.destroy();
      }
    },
    CASE_MS,
  );
});
