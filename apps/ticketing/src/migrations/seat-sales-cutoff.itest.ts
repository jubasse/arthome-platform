import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SeatSalesCutoff1790440900000 } from './1790440900000-seat-sales-cutoff.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';

/**
 * `SeatSalesCutoff1790440900000` on a database that already holds scheduled dates, as the stack's
 *   did: each one's end by time written from its start, one with no start left without.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const SCHEDULED = '01a0f710-0000-7000-8000-000000000001';
const UNSCHEDULED = '01a0f710-0000-7000-8000-000000000002';

let stack: StartedStack;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
}, STARTUP_MS);

afterAll(async () => {
  await stack?.stop();
});

describe('the seat sales cutoff backfill', () => {
  it(
    'writes each scheduled sale’s end thirty minutes after its start',
    async () => {
      const database = await createDatabase(stack.postgres, 'ticketing_sales_cutoff_migration');
      const { entities, migrations } = TICKETING_SCHEMA;
      if (!Array.isArray(migrations)) throw new Error('the schema lists its migrations');
      const before = await applyMigrations(database, {
        entities,
        migrations: migrations.filter((migration) => migration !== SeatSalesCutoff1790440900000),
      });
      try {
        await before.query(
          `INSERT INTO date_sales (date_id, channel_id, capacity_total, capacity_tiers,
                                   seats_available, seats_sold, waitlist_count, price_tiers,
                                   prices_locked_at, starts_at, version)
           VALUES ($1, 'channel-cutoff', 10, '[]', 10, 0, 0, '[]', now(),
                   '2026-12-12T19:00:00Z', 3),
                  ($2, 'channel-cutoff', 10, '[]', 10, 0, 0, '[]', now(), NULL, 3)`,
          [SCHEDULED, UNSCHEDULED],
        );
      } finally {
        await before.destroy();
      }

      const after = await applyMigrations(database, TICKETING_SCHEMA);
      try {
        const rows = await after.query<{ date_id: string; sales_end_at: Date | null }[]>(
          'SELECT date_id, sales_end_at FROM date_sales ORDER BY date_id',
        );
        expect(rows).toEqual([
          { date_id: SCHEDULED, sales_end_at: new Date('2026-12-12T19:30:00Z') },
          { date_id: UNSCHEDULED, sales_end_at: null },
        ]);
      } finally {
        await after.destroy();
      }
    },
    CASE_MS,
  );
});
