import { DateSalesAvailabilityChangedSchema } from '@arthome-platform/events';
import { OutboxEvent } from '@arthome-platform/messaging';
import { startStack, type StartedStack } from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  WAITLIST_PRIORITY_HOURS,
  WaitlistEntryState,
  plusHours,
  plusMinutes,
  plusSeconds,
} from '@arthome/core';

import { EndPriorityWindows } from './end-priority-windows.command.js';
import { PublishDueAvailability } from '../availability/publish-due-availability.command.js';
import { putOnSale } from '../itest/sales.js';
import {
  WAITLIST_CHANNEL,
  accountOf,
  buy,
  entryStatesOf,
  figuresOf,
  join,
  openTier,
  soldOutDate,
  startWaitlistHarness,
  travelTo,
  waitlistNotifiedOf,
  type WaitlistHarness,
} from '../itest/waitlist.js';

/**
 * The window's end in the sweeper (D-083): the pool's rest on public sale in one move, published at
 *   once since the date comes back from sold out; each notified entry `converted` when its account
 *   paid an order on the date since it was told, else `lapsed`; the count down by them; no event. A
 *   window extended since, or a date whose row is held, is left for a later pass.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const NOW = '2026-10-10T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const WINDOW_END = plusHours(NOW, WAITLIST_PRIORITY_HOURS);
const WINDOW_END_LATER = plusMinutes(WINDOW_END, 1);
const SERIES = '01a0fc04';
const BUYER = accountOf(SERIES, 999);

let stack: StartedStack;
let h: WaitlistHarness;
let dates = 0;

function nextDateId(): string {
  dates += 1;
  return `01a0fc40-0000-7000-8000-${String(dates).padStart(12, '0')}`;
}

const endWindows = (): Promise<number> => h.commands.execute(new EndPriorityWindows());

async function availabilityOf(dateId: string) {
  const rows = await h.dataSource.getRepository(OutboxEvent).find({
    where: { aggregateid: dateId, type: 'ticketing.date_sales.availability_changed.v1' },
    order: { created_at: 'ASC' },
  });
  return rows.map(({ payload }) => {
    const { seatsAvailable, soldOut } = fromBinary(DateSalesAvailabilityChangedSchema, payload);
    return { seatsAvailable, soldOut };
  });
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  h = await startWaitlistHarness(stack, 'ticketing_priority_window_end_itest', NOW);
}, STARTUP_MS);

beforeEach(() => {
  travelTo(h.clock, NOW);
});

afterAll(async () => {
  await h?.close();
  await stack?.stop();
});

describe("a priority window's end", () => {
  it(
    'puts the rest on public sale at once, converts the buyers, lapses the others, and counts them off',
    async () => {
      const dateId = nextDateId();
      const converts = accountOf(SERIES, 1);
      const lapses = accountOf(SERIES, 2);
      const boughtBefore = accountOf(SERIES, 3);
      await putOnSale(
        h.commands,
        { dateId, channelId: WAITLIST_CHANNEL, capacity: 4, startsAt: STARTS_AT },
        NOW,
      );
      await buy(h, boughtBefore, dateId, 1);
      await buy(h, BUYER, dateId, 3);
      travelTo(h.clock, plusMinutes(NOW, 1));
      for (const accountId of [converts, lapses, boughtBefore]) await join(h, dateId, accountId);
      await openTier(h, dateId, 3);
      travelTo(h.clock, plusMinutes(NOW, 10));
      await buy(h, converts, dateId, 1);
      travelTo(h.clock, plusSeconds(WINDOW_END_LATER, -1));
      await h.commands.execute(new PublishDueAvailability());
      const notifiedRows = (await waitlistNotifiedOf(h.dataSource, dateId)).length;

      travelTo(h.clock, WINDOW_END_LATER);
      expect(await endWindows()).toBe(1);
      await h.commands.execute(new PublishDueAvailability());

      expect(await figuresOf(h.dataSource, dateId)).toMatchObject({
        seats_available: 2,
        priority_pool_seats: 0,
        priority_until: null,
        waitlist_count: 0,
      });
      const states = await h.dataSource.query<{ account_id: string; state: string }[]>(
        'SELECT account_id, state FROM waitlist_entry WHERE date_id = $1 ORDER BY account_id',
        [dateId],
      );
      expect(states).toEqual([
        { account_id: converts, state: WaitlistEntryState.CONVERTED },
        { account_id: lapses, state: WaitlistEntryState.LAPSED },
        { account_id: boughtBefore, state: WaitlistEntryState.LAPSED },
      ]);
      expect((await availabilityOf(dateId)).slice(-2)).toEqual([
        { seatsAvailable: 0, soldOut: true },
        { seatsAvailable: 2, soldOut: false },
      ]);
      expect(await waitlistNotifiedOf(h.dataSource, dateId)).toHaveLength(notifiedRows);
      expect(await endWindows()).toBe(0);
    },
    CASE_MS,
  );

  it(
    'leaves a window a later tier extended alone',
    async () => {
      const dateId = nextDateId();
      await soldOutDate(h, dateId, 2, BUYER, STARTS_AT);
      await join(h, dateId, accountOf(SERIES, 10));
      await openTier(h, dateId, 1);
      travelTo(h.clock, plusHours(NOW, 1));
      await openTier(h, dateId, 1);

      travelTo(h.clock, WINDOW_END);
      expect(await endWindows()).toBe(0);

      expect(await figuresOf(h.dataSource, dateId)).toMatchObject({
        priority_pool_seats: 2,
        priority_until: new Date(plusHours(NOW, 1 + WAITLIST_PRIORITY_HOURS)),
        waitlist_count: 1,
      });
      expect(await entryStatesOf(h.dataSource, dateId)).toEqual({ notified: 1 });
    },
    CASE_MS,
  );

  it(
    "skips a date whose row another transaction holds, and ends it once it's free",
    async () => {
      const dateId = nextDateId();
      await soldOutDate(h, dateId, 2, BUYER, STARTS_AT);
      await join(h, dateId, accountOf(SERIES, 20));
      await openTier(h, dateId, 1);
      travelTo(h.clock, WINDOW_END);

      const holder = h.dataSource.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      try {
        await holder.query('SELECT 1 FROM date_sales WHERE date_id = $1 FOR UPDATE', [dateId]);
        expect(await endWindows()).toBe(0);
      } finally {
        await holder.rollbackTransaction();
        await holder.release();
      }

      expect(await endWindows()).toBe(1);
      expect(await entryStatesOf(h.dataSource, dateId)).toEqual({ lapsed: 1 });
    },
    CASE_MS,
  );
});
