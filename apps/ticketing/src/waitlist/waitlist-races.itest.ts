import { startStack, type StartedStack } from '@arthome-platform/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { OrderErrorCode, WAITLIST_PRIORITY_HOURS, plusHours } from '@arthome/core';

import { EndPriorityWindows } from './end-priority-windows.command.js';
import {
  accountOf,
  buy,
  entryStatesOf,
  figuresOf,
  join,
  leaveOf,
  openTier,
  refusalOf,
  seedWaitingEntries,
  soldOutDate,
  startWaitlistHarness,
  travelTo,
  type WaitlistHarness,
} from '../itest/waitlist.js';
import { PurchaseStatus } from '../orders/purchase-seat.command.js';

/**
 * The races the date's row orders (HANDOVER §0p): joins against a tier opening and a window's end,
 *   notified buyers against the pool, leaves against a tier opening. Each join, leave, opening and
 *   end takes the date's row first; the purchase reads the entry unlocked and holds the window's
 *   end in its statement.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 120_000;

const NOW = '2026-10-10T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const BUYER = accountOf('01a0fc08', 999_999);

let stack: StartedStack;
let h: WaitlistHarness;
let dates = 0;

async function soldOut(): Promise<string> {
  dates += 1;
  const dateId = `01a0fc80-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await soldOutDate(h, dateId, 2, BUYER, STARTS_AT);
  return dateId;
}

function accounts(series: string, count: number): string[] {
  return Array.from({ length: count }, (_, n) => accountOf(series, n + 1));
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  h = await startWaitlistHarness(stack, 'ticketing_waitlist_races_itest', NOW);
}, STARTUP_MS);

beforeEach(() => {
  travelTo(h.clock, NOW);
});

afterAll(async () => {
  await h?.close();
  await stack?.stop();
});

describe('the waiting list under concurrency', () => {
  it(
    'leaves none of 200 joins racing a tier opening waiting while the window is open',
    async () => {
      const dateId = await soldOut();
      const joiners = accounts('01a0fc81', 200);
      await join(h, dateId, BUYER);

      const joins = joiners.map((accountId) => join(h, dateId, accountId));
      const [opened] = await Promise.all([openTier(h, dateId, 10), ...joins]);

      expect(opened.priorityUntil).toBeDefined();
      expect(await entryStatesOf(h.dataSource, dateId)).toEqual({ notified: 201 });
      expect((await figuresOf(h.dataSource, dateId)).waitlist_count).toBe(201);
    },
    CASE_MS,
  );

  it(
    "leaves none notified after joins race the window's end",
    async () => {
      const dateId = await soldOut();
      await seedWaitingEntries(h.dataSource, dateId, '01a0fc82', 50, NOW);
      await openTier(h, dateId, 5);
      travelTo(h.clock, plusHours(NOW, WAITLIST_PRIORITY_HOURS));

      const late = accounts('01a0fc83', 100);
      // Joined waiting before the end commits, refused not sold out after it. A pass that found
      //   the row held by a join skips it, and a later one ends it.
      await Promise.allSettled([
        h.commands.execute(new EndPriorityWindows()),
        ...late.map((accountId) => join(h, dateId, accountId)),
      ]);
      for (let pass = 0; pass < 5; pass += 1) {
        if ((await figuresOf(h.dataSource, dateId)).priority_until === null) break;
        await h.commands.execute(new EndPriorityWindows());
      }

      const states = await entryStatesOf(h.dataSource, dateId);
      expect(states.notified).toBeUndefined();
      expect(states.lapsed).toBe(50);
      const figures = await figuresOf(h.dataSource, dateId);
      expect(figures.waitlist_count).toBe(states.waiting ?? 0);
      expect(figures.priority_until).toBeNull();
    },
    CASE_MS,
  );

  it(
    'sells exactly 100 seats to 300 notified buyers racing for a pool of 100, the public at 0',
    async () => {
      const dateId = await soldOut();
      const series = '01a0fc84';
      await seedWaitingEntries(h.dataSource, dateId, series, 300, NOW);
      await openTier(h, dateId, 100);

      const answers = await Promise.allSettled(
        accounts(series, 300).map((accountId) => buy(h, accountId, dateId, 1)),
      );

      const paid = answers.filter(
        (answer) => answer.status === 'fulfilled' && answer.value.status === PurchaseStatus.PAID,
      );
      expect(paid).toHaveLength(100);
      const refusals = answers.flatMap((answer) =>
        answer.status === 'rejected' ? [refusalOf(Promise.reject(answer.reason as Error))] : [],
      );
      for (const refusal of await Promise.all(refusals)) {
        expect(refusal.refusal.code).toBe(OrderErrorCode.SOLD_OUT);
      }
      expect(await figuresOf(h.dataSource, dateId)).toMatchObject({
        seats_available: 0,
        priority_pool_seats: 0,
        seats_sold: 102,
        seats_held: 0,
      });
    },
    CASE_MS,
  );

  it(
    'commits leaves racing a tier opening without a deadlock',
    async () => {
      const dateId = await soldOut();
      const series = '01a0fc85';
      await seedWaitingEntries(h.dataSource, dateId, series, 100, NOW);

      const leaves = accounts(series, 100).map((accountId) =>
        h.commands.execute(leaveOf(dateId, accountId)),
      );
      const settled = await Promise.allSettled([openTier(h, dateId, 10), ...leaves]);

      expect(settled.filter(({ status }) => status === 'rejected')).toEqual([]);
      expect(await entryStatesOf(h.dataSource, dateId)).toEqual({ left: 100 });
      expect((await figuresOf(h.dataSource, dateId)).waitlist_count).toBe(0);
    },
    CASE_MS,
  );
});
