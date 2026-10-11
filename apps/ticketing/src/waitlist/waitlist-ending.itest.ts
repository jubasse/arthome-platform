import { DateOutcome as WireDateOutcome } from '@arthome-platform/events';
import { startStack, type StartedStack } from '@arthome-platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrderErrorCode, WaitlistEntryState, plusHours } from '@arthome/core';

import { WaitlistEndingHook } from './waitlist-ending-hook.js';
import { SettleDateOutcomes } from '../date-outcomes/settle-date-outcomes.command.js';
import { applyCatalogDateMessage } from '../date-sales/catalog-date-messages.js';
import { delivered, outcomeDeclared, rescheduled } from '../itest/catalog-messages.js';
import {
  accountOf,
  buy,
  entryStatesOf,
  figuresOf,
  join,
  joinOf,
  openTier,
  refusalOf,
  soldOutDate,
  startWaitlistHarness,
  waitlistNotifiedOf,
  type WaitlistHarness,
} from '../itest/waitlist.js';

/**
 * D-096 through PT1's settlement pass: a cancellation or an interruption, applied by the consumer
 *   then settled, closes the pool into the closed sale, every waiting entry and every notified one
 *   that did not buy `closed`, a buyer `converted`, the count 0, and tells nobody. Run again it
 *   moves nothing; a postponement ends nothing.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const NOW = '2026-10-10T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const SERIES = '01a0fc05';
const BUYER = accountOf(SERIES, 999);

let stack: StartedStack;
let h: WaitlistHarness;
let dates = 0;
let accounts = 0;

function nextAccount(): string {
  accounts += 1;
  return accountOf(SERIES, accounts);
}

async function soldOut(): Promise<string> {
  dates += 1;
  const dateId = `01a0fc50-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await soldOutDate(h, dateId, 2, BUYER, STARTS_AT);
  return dateId;
}

/** A window open: one notified account that bought from the pool, one that did not. */
async function windowOpen(): Promise<{ dateId: string; bought: string; idle: string }> {
  const dateId = await soldOut();
  const bought = nextAccount();
  const idle = nextAccount();
  await join(h, dateId, bought);
  await join(h, dateId, idle);
  await openTier(h, dateId, 3);
  await buy(h, bought, dateId, 1);
  return { dateId, bought, idle };
}

/** No window: two accounts waiting. */
async function listWaiting(): Promise<string> {
  const dateId = await soldOut();
  await join(h, dateId, nextAccount());
  await join(h, dateId, nextAccount());
  return dateId;
}

async function statesOf(dateId: string): Promise<{ account_id: string; state: string }[]> {
  return h.dataSource.query(
    'SELECT account_id, state FROM waitlist_entry WHERE date_id = $1 ORDER BY account_id',
    [dateId],
  );
}

async function versionsOf(dateId: string): Promise<unknown[]> {
  return h.dataSource.query(
    `SELECT entry.version, sales.availability_moves
       FROM waitlist_entry AS entry JOIN date_sales AS sales USING (date_id)
      WHERE date_id = $1 ORDER BY entry.account_id`,
    [dateId],
  );
}

async function declare(dateId: string, outcome: WireDateOutcome): Promise<void> {
  await applyCatalogDateMessage(h.commands, delivered(outcomeDeclared(dateId, outcome, NOW)));
}

async function settle(): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) await h.commands.execute(new SettleDateOutcomes());
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  h = await startWaitlistHarness(stack, 'ticketing_waitlist_ending_itest', NOW);
}, STARTUP_MS);

afterAll(async () => {
  await h?.close();
  await stack?.stop();
});

describe("a date's outcome and its waiting list (D-096)", () => {
  it.each([
    ['cancellation', WireDateOutcome.CANCELLED],
    ['interruption', WireDateOutcome.INTERRUPTED],
  ] as const)(
    'a %s closes every entry and the pool, a buyer converted, and tells nobody',
    async (_outcome, outcome) => {
      const open = await windowOpen();
      const waiting = await listWaiting();
      const told = (await waitlistNotifiedOf(h.dataSource, open.dateId)).length;

      for (const dateId of [open.dateId, waiting]) await declare(dateId, outcome);
      await settle();

      expect(await statesOf(open.dateId)).toEqual([
        { account_id: open.bought, state: WaitlistEntryState.CONVERTED },
        { account_id: open.idle, state: WaitlistEntryState.CLOSED },
      ]);
      expect(await entryStatesOf(h.dataSource, waiting)).toEqual({ closed: 2 });
      for (const dateId of [open.dateId, waiting]) {
        expect(await figuresOf(h.dataSource, dateId)).toMatchObject({
          priority_pool_seats: 0,
          priority_until: null,
          waitlist_count: 0,
        });
      }
      expect((await figuresOf(h.dataSource, open.dateId)).seats_available).toBe(2);
      expect(await waitlistNotifiedOf(h.dataSource, open.dateId)).toHaveLength(told);

      const refusal = await refusalOf(h.commands.execute(joinOf(waiting, nextAccount())));
      expect(refusal.refusal.code).toBe(OrderErrorCode.SALES_CLOSED);
    },
    CASE_MS,
  );

  it(
    'moves nothing when the hook runs again',
    async () => {
      const open = await windowOpen();
      await declare(open.dateId, WireDateOutcome.CANCELLED);
      await settle();
      const before = await versionsOf(open.dateId);

      await h.transactions.run((transaction) =>
        new WaitlistEndingHook().endWaitlist(transaction, open.dateId, h.clock.now()),
      );

      expect(await versionsOf(open.dateId)).toEqual(before);
    },
    CASE_MS,
  );

  it(
    'leaves the entries waiting on a postponement',
    async () => {
      const dateId = await listWaiting();

      await declare(dateId, WireDateOutcome.POSTPONED);
      await applyCatalogDateMessage(
        h.commands,
        delivered(rescheduled(dateId, plusHours(STARTS_AT, 24 * 7), NOW)),
      );
      await settle();

      expect(await entryStatesOf(h.dataSource, dateId)).toEqual({ waiting: 2 });
      expect((await figuresOf(h.dataSource, dateId)).waitlist_count).toBe(2);
    },
    CASE_MS,
  );
});
