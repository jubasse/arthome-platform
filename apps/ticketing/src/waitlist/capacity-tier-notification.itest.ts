import { startStack, type StartedStack } from '@arthome-platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WAITLIST_NOTIFIED_ACCOUNTS_MAX, plusMinutes, priorityUntilOf } from '@arthome/core';

import {
  accountOf,
  entryStatesOf,
  figuresOf,
  join,
  openTier,
  seedWaitingEntries,
  soldOutDate,
  startWaitlistHarness,
  travelTo,
  waitlistNotifiedOf,
  type WaitlistHarness,
} from '../itest/waitlist.js';

/**
 * `openCapacityTier` and the list (adr-ticketing.md §9, D-083, D-094): in its one transaction the
 *   tier becomes the pool, the window opens, every entry is notified and named in rows of at most
 *   500 accounts; with `notifyWaitlist: false` or nobody on the list, the seats go on public sale.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const NOW = '2026-10-10T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const BUYER = accountOf('01a0fc02', 999_999);

let stack: StartedStack;
let h: WaitlistHarness;
let dates = 0;

async function soldOut(capacity = 4): Promise<string> {
  dates += 1;
  const dateId = `01a0fc20-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await soldOutDate(h, dateId, capacity, BUYER, STARTS_AT);
  return dateId;
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  h = await startWaitlistHarness(stack, 'ticketing_tier_notification_itest', NOW);
}, STARTUP_MS);

afterAll(async () => {
  await h?.close();
  await stack?.stop();
});

describe('a tier opened for the waiting list', () => {
  it(
    'notifies 1,201 entries in rows of 500, 500 and 201, the tier the pool, the public sold out',
    async () => {
      const dateId = await soldOut();
      const series = '01a0fc21';
      await seedWaitingEntries(h.dataSource, dateId, series, 1_201, NOW);

      const opened = await openTier(h, dateId, 50);

      expect(opened).toMatchObject({
        waitlistNotified: 1_201,
        priorityUntil: priorityUntilOf(NOW),
      });
      expect(opened.sales).toMatchObject({
        capacityTotal: 54,
        seatsAvailable: 0,
        waitlistCount: 1_201,
        priorityPool: { seatsLeft: 50, priorityUntil: priorityUntilOf(NOW) },
      });
      expect(await figuresOf(h.dataSource, dateId)).toMatchObject({
        seats_available: 0,
        priority_pool_seats: 50,
        waitlist_count: 1_201,
        priority_until: new Date(priorityUntilOf(NOW)),
      });
      expect(await entryStatesOf(h.dataSource, dateId)).toEqual({ notified: 1_201 });
      const rows = await waitlistNotifiedOf(h.dataSource, dateId);
      expect(rows.map(({ accountIds }) => accountIds.length)).toEqual([
        WAITLIST_NOTIFIED_ACCOUNTS_MAX,
        WAITLIST_NOTIFIED_ACCOUNTS_MAX,
        201,
      ]);
      const named = rows.flatMap(({ accountIds }) => accountIds);
      expect(named).toEqual(Array.from({ length: 1_201 }, (_, n) => accountOf(series, n + 1)));
      expect(
        rows.every(
          ({ priorityUntil, key }) => priorityUntil === priorityUntilOf(NOW) && key === dateId,
        ),
      ).toBe(true);
    },
    CASE_MS,
  );

  it(
    'puts the tier on public sale with notifyWaitlist false, nobody notified',
    async () => {
      const dateId = await soldOut();
      await join(h, dateId, accountOf('01a0fc22', 1));

      const opened = await openTier(h, dateId, 6, false);

      expect(opened.waitlistNotified).toBe(0);
      expect(opened).not.toHaveProperty('priorityUntil');
      expect(opened.sales).not.toHaveProperty('priorityPool');
      expect(await figuresOf(h.dataSource, dateId)).toMatchObject({
        seats_available: 6,
        priority_pool_seats: 0,
        priority_until: null,
      });
      expect(await entryStatesOf(h.dataSource, dateId)).toEqual({ waiting: 1 });
      expect(await waitlistNotifiedOf(h.dataSource, dateId)).toEqual([]);
    },
    CASE_MS,
  );

  it(
    'puts the tier on public sale when nobody is on the list',
    async () => {
      const dateId = await soldOut();

      const opened = await openTier(h, dateId, 6);

      expect(opened.waitlistNotified).toBe(0);
      expect(opened).not.toHaveProperty('priorityUntil');
      expect(await figuresOf(h.dataSource, dateId)).toMatchObject({
        seats_available: 6,
        priority_pool_seats: 0,
        priority_until: null,
      });
    },
    CASE_MS,
  );

  it(
    'extends the window with a second tier and notifies the whole list again',
    async () => {
      const dateId = await soldOut();
      const first = accountOf('01a0fc23', 1);
      const second = accountOf('01a0fc23', 2);
      await join(h, dateId, first);
      await openTier(h, dateId, 3);
      const [{ notified_at: firstToldAt } = { notified_at: null }] = await h.dataSource.query<
        { notified_at: Date | null }[]
      >('SELECT notified_at FROM waitlist_entry WHERE account_id = $1', [first]);
      const later = plusMinutes(NOW, 30);
      travelTo(h.clock, later);
      try {
        await join(h, dateId, second);

        const opened = await openTier(h, dateId, 2);

        expect(opened).toMatchObject({
          waitlistNotified: 2,
          priorityUntil: priorityUntilOf(later),
        });
        expect(await figuresOf(h.dataSource, dateId)).toMatchObject({
          priority_pool_seats: 5,
          seats_available: 0,
          priority_until: new Date(priorityUntilOf(later)),
        });
        const rows = await waitlistNotifiedOf(h.dataSource, dateId);
        expect(rows.map(({ accountIds }) => accountIds)).toEqual([
          [first],
          [second],
          [first, second].sort(),
        ]);
        // Told first at the first tier: a purchase in the first window still converts it.
        const told = await h.dataSource.query<{ notified_at: Date }[]>(
          'SELECT notified_at FROM waitlist_entry WHERE account_id = $1',
          [first],
        );
        expect(told).toEqual([{ notified_at: firstToldAt }]);
      } finally {
        travelTo(h.clock, NOW);
      }
    },
    CASE_MS,
  );
});
