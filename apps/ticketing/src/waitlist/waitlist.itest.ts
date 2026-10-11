import type { MemorisedResponse } from '@arthome-platform/http-edge';
import { Outcome } from '@arthome-platform/messaging';
import { startStack, type StartedStack } from '@arthome-platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ApiErrorCode,
  OrderErrorCode,
  WAITLIST_PRIORITY_HOURS,
  WaitlistEntryState,
  plusHours,
  priorityUntilOf,
} from '@arthome/core';

import { EndPriorityWindows } from './end-priority-windows.command.js';
import { GetWaitlistRegistration } from './get-waitlist-registration.query.js';
import type { WaitlistDepartureView } from './leave-waitlist.command.js';
import type { WaitlistRegistrationView } from './waitlist-registration.js';
import { applyCatalogDateMessage } from '../date-sales/catalog-date-messages.js';
import { delivered, drafted } from '../itest/catalog-messages.js';
import { nextKey, putOnSale } from '../itest/sales.js';
import {
  WAITLIST_CHANNEL,
  accountOf,
  buy,
  entryStatesOf,
  figuresOf,
  join,
  joinOf,
  leaveOf,
  openTier,
  refusalOf,
  soldOutDate,
  startWaitlistHarness,
  travelTo,
  waitlistNotifiedOf,
  type WaitlistHarness,
} from '../itest/waitlist.js';

/**
 * Joining, leaving and reading a registration (D-083), through the buses on a real Postgres: a
 *   state assignment under the date's row, its count moved without the version, and a join into an
 *   open window notified at once with a `waitlist.notified` of its own.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const NOW = '2026-10-10T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const SERIES = '01a0fc01';
const BUYER = accountOf(SERIES, 999);

let stack: StartedStack;
let h: WaitlistHarness;
let dates = 0;
let accounts = 0;

function nextDateId(): string {
  dates += 1;
  return `01a0fc10-0000-7000-8000-${String(dates).padStart(12, '0')}`;
}

function nextAccount(): string {
  accounts += 1;
  return accountOf(SERIES, accounts);
}

async function soldOut(capacity = 2): Promise<string> {
  const dateId = nextDateId();
  await soldOutDate(h, dateId, capacity, BUYER, STARTS_AT);
  return dateId;
}

async function versionOf(dateId: string): Promise<number> {
  const [row] = await h.dataSource.query<{ version: number }[]>(
    'SELECT version FROM date_sales WHERE date_id = $1',
    [dateId],
  );
  return row?.version ?? 0;
}

function registrationOf(dateId: string, accountId: string): Promise<WaitlistRegistrationView> {
  return h.queries.execute(new GetWaitlistRegistration(dateId, accountId));
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  h = await startWaitlistHarness(stack, 'ticketing_waitlist_itest', NOW);
}, STARTUP_MS);

afterAll(async () => {
  await h?.close();
  await stack?.stop();
});

describe('joining the waiting list', () => {
  it(
    'is refused while public seats remain, writing nothing',
    async () => {
      const dateId = nextDateId();
      await putOnSale(
        h.commands,
        { dateId, channelId: WAITLIST_CHANNEL, capacity: 5, startsAt: STARTS_AT },
        NOW,
      );

      const refusal = await refusalOf(h.commands.execute(joinOf(dateId, nextAccount())));

      expect(refusal.refusal.code).toBe(OrderErrorCode.WAITLIST_NOT_SOLD_OUT);
      expect(await entryStatesOf(h.dataSource, dateId)).toEqual({});
      expect((await figuresOf(h.dataSource, dateId)).waitlist_count).toBe(0);
    },
    CASE_MS,
  );

  it(
    'registers on a sold-out date without a rank, the count moved and the version not',
    async () => {
      const dateId = await soldOut();
      const version = await versionOf(dateId);
      const accountId = nextAccount();

      expect(await join(h, dateId, accountId)).toEqual({
        joined: true,
        state: WaitlistEntryState.WAITING,
        rankDisclosed: false,
        rank: null,
        priorityWindowHours: WAITLIST_PRIORITY_HOURS,
        priorityUntil: null,
      });

      expect(await entryStatesOf(h.dataSource, dateId)).toEqual({ waiting: 1 });
      expect((await figuresOf(h.dataSource, dateId)).waitlist_count).toBe(1);
      expect(await versionOf(dateId)).toBe(version);
      expect(await waitlistNotifiedOf(h.dataSource, dateId)).toEqual([]);
      expect(await registrationOf(dateId, accountId)).toMatchObject({
        joined: true,
        state: WaitlistEntryState.WAITING,
      });
    },
    CASE_MS,
  );

  it(
    'leaves one registration and one count for two submissions under two keys, and replays a key',
    async () => {
      const dateId = await soldOut();
      const accountId = nextAccount();
      const key = nextKey();

      const first: MemorisedResponse<WaitlistRegistrationView> = await h.commands.execute(
        joinOf(dateId, accountId, key),
      );
      const second = await join(h, dateId, accountId);
      const replayed: MemorisedResponse<WaitlistRegistrationView> = await h.commands.execute(
        joinOf(dateId, accountId, key),
      );

      expect(second).toEqual(first.envelope.data);
      expect(replayed.replayed).toBe(true);
      expect(await entryStatesOf(h.dataSource, dateId)).toEqual({ waiting: 1 });
      expect((await figuresOf(h.dataSource, dateId)).waitlist_count).toBe(1);
    },
    CASE_MS,
  );

  it(
    'notifies an account joining into an open window at once, with one event naming it',
    async () => {
      const dateId = await soldOut();
      await join(h, dateId, nextAccount());
      await openTier(h, dateId, 3);
      const late = nextAccount();

      const registration = await join(h, dateId, late);

      expect(registration).toEqual({
        joined: true,
        state: WaitlistEntryState.NOTIFIED,
        rankDisclosed: false,
        rank: null,
        priorityWindowHours: WAITLIST_PRIORITY_HOURS,
        priorityUntil: priorityUntilOf(NOW),
        priorityPoolSeats: 3,
      });
      const notified = await waitlistNotifiedOf(h.dataSource, dateId);
      expect(notified).toHaveLength(2);
      expect(notified[1]).toEqual({
        accountIds: [late],
        priorityUntil: priorityUntilOf(NOW),
        key: dateId,
      });
      expect((await figuresOf(h.dataSource, dateId)).waitlist_count).toBe(2);
    },
    CASE_MS,
  );

  it(
    'registers again on the same row after a lapse',
    async () => {
      const dateId = await soldOut();
      const accountId = nextAccount();
      await join(h, dateId, accountId);
      await openTier(h, dateId, 1);
      travelTo(h.clock, plusHours(NOW, WAITLIST_PRIORITY_HOURS));
      try {
        await h.commands.execute(new EndPriorityWindows());
        expect(await registrationOf(dateId, accountId)).toMatchObject({
          joined: false,
          state: WaitlistEntryState.LAPSED,
          priorityUntil: null,
        });
        // The pool's rest went on public sale: sold out again before the account joins again.
        await buy(h, BUYER, dateId, 1);
        const [before] = await h.dataSource.query<{ id: string }[]>(
          'SELECT id FROM waitlist_entry WHERE date_id = $1',
          [dateId],
        );

        expect(await join(h, dateId, accountId)).toMatchObject({
          joined: true,
          state: WaitlistEntryState.WAITING,
        });

        const after = await h.dataSource.query<{ id: string }[]>(
          'SELECT id FROM waitlist_entry WHERE date_id = $1',
          [dateId],
        );
        expect(after).toEqual([before]);
        expect((await figuresOf(h.dataSource, dateId)).waitlist_count).toBe(1);
      } finally {
        travelTo(h.clock, NOW);
      }
    },
    CASE_MS,
  );

  it(
    'answers 404 for a date ticketing does not hold, or whose sale never opened',
    async () => {
      const unknown = nextDateId();
      const draft = nextDateId();
      expect(
        await applyCatalogDateMessage(h.commands, delivered(drafted(draft, WAITLIST_CHANNEL, NOW))),
      ).toBe(Outcome.APPLIED);

      for (const dateId of [unknown, draft]) {
        expect(
          (await refusalOf(h.commands.execute(joinOf(dateId, nextAccount())))).refusal.code,
        ).toBe(ApiErrorCode.NOT_FOUND);
        expect((await refusalOf(registrationOf(dateId, nextAccount()))).refusal.code).toBe(
          ApiErrorCode.NOT_FOUND,
        );
      }
      expect(
        (await refusalOf(h.commands.execute(leaveOf(unknown, nextAccount())))).refusal.code,
      ).toBe(ApiErrorCode.NOT_FOUND);
    },
    CASE_MS,
  );
});

describe('leaving the waiting list', () => {
  it(
    'leaves once, then answers the same and writes nothing',
    async () => {
      const dateId = await soldOut();
      const accountId = nextAccount();
      await join(h, dateId, accountId);

      const left: MemorisedResponse<WaitlistDepartureView> = await h.commands.execute(
        leaveOf(dateId, accountId),
      );
      const [entry] = await h.dataSource.query<{ version: number }[]>(
        'SELECT version FROM waitlist_entry WHERE date_id = $1',
        [dateId],
      );
      const again: MemorisedResponse<WaitlistDepartureView> = await h.commands.execute(
        leaveOf(dateId, accountId),
      );

      expect([left.envelope.data, again.envelope.data]).toEqual([
        { joined: false },
        { joined: false },
      ]);
      expect(await entryStatesOf(h.dataSource, dateId)).toEqual({ left: 1 });
      expect(
        await h.dataSource.query('SELECT version FROM waitlist_entry WHERE date_id = $1', [dateId]),
      ).toEqual([entry]);
      expect((await figuresOf(h.dataSource, dateId)).waitlist_count).toBe(0);
      expect(await registrationOf(dateId, accountId)).toMatchObject({
        joined: false,
        state: WaitlistEntryState.LEFT,
      });
    },
    CASE_MS,
  );

  it(
    'answers an account never registered as not joined, with no state',
    async () => {
      const dateId = await soldOut();
      const stranger = nextAccount();

      const left: MemorisedResponse<WaitlistDepartureView> = await h.commands.execute(
        leaveOf(dateId, stranger),
      );

      expect(left.envelope.data).toEqual({ joined: false });
      expect(await registrationOf(dateId, stranger)).toMatchObject({ joined: false, state: null });
    },
    CASE_MS,
  );
});
