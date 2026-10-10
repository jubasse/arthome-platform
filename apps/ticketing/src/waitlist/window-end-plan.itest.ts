import { startStack, type StartedStack } from '@arthome-platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WAITLIST_PRIORITY_HOURS, WaitlistEntryState, plusHours, plusMinutes } from '@arthome/core';

import { EndPriorityWindows } from './end-priority-windows.command.js';
import { CONVERT_NOTIFIED_ENTRIES } from './waitlist-entry.typeorm-repository.js';
import { seedPaidOrders } from '../itest/paid-orders.js';
import {
  WAITLIST_CHANNEL,
  accountOf,
  entryStatesOf,
  openTier,
  soldOutDate,
  startWaitlistHarness,
  travelTo,
  type WaitlistHarness,
} from '../itest/waitlist.js';

/**
 * The window's end at scale: the conversion finds each entry's paid order by index among 20,000
 *   orders, never by reading them all; and how long the date's row is held while 10,000 entries end,
 *   printed for the HANDOVER, never asserted.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 240_000;

const NOW = '2026-10-10T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const DATE_ID = '01a0fc90-0000-7000-8000-000000000001';
const ACCOUNTS = '01a0fc91';
const ORDERS = 20_000;
const ENTRIES = 10_000;

let stack: StartedStack;
let h: WaitlistHarness;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  h = await startWaitlistHarness(stack, 'ticketing_window_end_plan_itest', NOW);
}, STARTUP_MS);

afterAll(async () => {
  await h?.close();
  await stack?.stop();
});

describe("the window's end at scale", () => {
  it(
    'converts by index over 20,000 orders, and prints how long 10,000 entries hold the row',
    async () => {
      await soldOutDate(h, DATE_ID, 2, accountOf(ACCOUNTS, 999_999), STARTS_AT);
      // Accounts 15,001 to 25,000 on the list: half of them paid an order in the window.
      const firstListed = ORDERS - ENTRIES / 2 + 1;
      await h.dataSource.query(
        `INSERT INTO waitlist_entry (id, date_id, account_id, state, joined_at, version)
         SELECT gen_random_uuid(), $1, ($2 || '-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
                $6, $4, 1
           FROM generate_series($3::int, $3::int + $5::int - 1) AS n`,
        [DATE_ID, ACCOUNTS, firstListed, new Date(NOW), ENTRIES, WaitlistEntryState.WAITING],
      );
      await h.dataSource.query('UPDATE date_sales SET waitlist_count = $2 WHERE date_id = $1', [
        DATE_ID,
        ENTRIES,
      ]);
      await openTier(h, DATE_ID, 100);
      await seedPaidOrders(h.dataSource, {
        dateId: DATE_ID,
        channelId: WAITLIST_CHANNEL,
        series: '01a0fc92',
        quantities: Array.from({ length: ORDERS }, () => 1),
        accountId: null,
        cancelDeadline: null,
        paidAt: plusMinutes(NOW, 10),
      });
      await h.dataSource.query(
        `UPDATE seat_order
            SET account_id = ($2 || '-0000-7000-8000-' || lpad(substr(reference, 19)::text, 12, '0'))::uuid
          WHERE date_id = $1 AND account_id IS NULL`,
        [DATE_ID, ACCOUNTS],
      );
      await h.dataSource.query('ANALYZE seat_order');
      await h.dataSource.query('ANALYZE waitlist_entry');

      const plan = await h.dataSource.query<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN ${CONVERT_NOTIFIED_ENTRIES}`,
        [DATE_ID, new Date(plusHours(NOW, WAITLIST_PRIORITY_HOURS))],
      );
      const lines = plan.map((line) => line['QUERY PLAN']).join('\n');
      expect(lines).not.toMatch(/Seq Scan on seat_order/);
      expect(lines).toMatch(/Index Scan using seat_order_idempotency/);

      travelTo(h.clock, plusHours(NOW, WAITLIST_PRIORITY_HOURS));
      const started = performance.now();
      expect(await h.commands.execute(new EndPriorityWindows())).toBe(1);
      const heldMs = performance.now() - started;
      process.stdout.write(
        `window end: ${String(ENTRIES)} entries ended in ${heldMs.toFixed(0)} ms\n`,
      );

      expect(await entryStatesOf(h.dataSource, DATE_ID)).toEqual({
        converted: ENTRIES / 2,
        lapsed: ENTRIES / 2,
      });
    },
    CASE_MS,
  );
});
