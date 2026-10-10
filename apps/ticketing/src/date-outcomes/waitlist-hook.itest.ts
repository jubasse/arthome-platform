import { DateOutcome as WireDateOutcome } from '@arthome-platform/events';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, RefundReason, type Instant } from '@arthome/core';

import { SettleDateOutcomes } from './settle-date-outcomes.command.js';
import {
  DATE_OUTCOME_RETRY_SECONDS,
  SettleDateOutcomesHandler,
} from './settle-date-outcomes.handler.js';
import { WaitlistOutcomeHook } from './waitlist-outcome-hook.js';
import { CLOCK } from '../clock.js';
import { ApplyCatalogDateFactHandler } from '../date-sales/apply-catalog-date-fact.handler.js';
import { applyCatalogDateMessage } from '../date-sales/catalog-date-messages.js';
import { OpenCapacityTierHandler } from '../date-sales/open-capacity-tier.handler.js';
import { SetDatePricesHandler } from '../date-sales/set-date-prices.handler.js';
import { delivered, outcomeDeclared } from '../itest/catalog-messages.js';
import { seedPaidOrders } from '../itest/paid-orders.js';
import { putOnSale } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { TicketingTransactions, type TicketingTransaction } from '../ticketing-transactions.js';

/**
 * D-096 through the port PT3 implements (HANDOVER §0n): the settlement pass calls it once per
 *   cancelled or interrupted date, in a transaction of its own holding the date's settlement row,
 *   and a date whose hook fails is set aside, tried again, and settled only once it passed.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const NOW = '2026-10-05T10:00:00.000Z';
const CHANNEL = '01a0e70c-0000-7000-8000-000000000001';
const ACCOUNT = '01a0e7aa-0000-7000-8000-000000000001';

interface HookCall {
  readonly dateId: string;
  readonly at: Instant;
  readonly transactionId: string;
  readonly settlementHeld: boolean;
}

class RecordingWaitlistOutcomeHook extends WaitlistOutcomeHook {
  public readonly calls: HookCall[] = [];
  public failuresLeft = 0;
  public dataSource: DataSource | null = null;

  public async endWaitlist(
    { manager }: TicketingTransaction,
    dateId: string,
    now: Instant,
  ): Promise<void> {
    const [current] = await manager.query<{ id: string }[]>(
      'SELECT (txid_current() % 4294967296)::text AS id',
    );
    this.calls.push({
      dateId,
      at: now,
      transactionId: current?.id ?? '',
      settlementHeld: await this.heldElsewhere(dateId),
    });
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error('the waiting list could not be ended');
    }
  }

  /** From another connection: the row this transaction should hold. */
  private async heldElsewhere(dateId: string): Promise<boolean> {
    try {
      await this.dataSource?.query(
        'SELECT 1 FROM date_outcome_settlement WHERE date_id = $1 FOR UPDATE NOWAIT',
        [dateId],
      );
      return false;
    } catch {
      return true;
    }
  }
}

let stack: StartedStack;
let dataSource: DataSource;
let cqrs: TestingModule;
let commands: CommandBus;
let clock: FixedClock;
const hook = new RecordingWaitlistOutcomeHook();
let dates = 0;

const settle = (): Promise<number> => commands.execute(new SettleDateOutcomes());

async function dateClosedBy(outcome: WireDateOutcome, orders: number): Promise<string> {
  dates += 1;
  const dateId = `01a0e700-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await putOnSale(commands, { dateId, channelId: CHANNEL, capacity: 10 }, clock.now());
  await seedPaidOrders(dataSource, {
    dateId,
    channelId: CHANNEL,
    series: `01a0e7${String(dates).padStart(2, '0')}`,
    quantities: Array.from({ length: orders }, () => 1),
    accountId: ACCOUNT,
    cancelDeadline: null,
    paidAt: clock.now(),
  });
  await applyCatalogDateMessage(commands, delivered(outcomeDeclared(dateId, outcome, clock.now())));
  return dateId;
}

async function settlementOf(dateId: string) {
  const [row] = await dataSource.query<
    { waitlist_ended_at: Date | null; settled_at: Date | null; failed_at: Date | null }[]
  >(
    `SELECT waitlist_ended_at, settled_at, failed_at FROM date_outcome_settlement
      WHERE date_id = $1`,
    [dateId],
  );
  return row;
}

const callsOf = (dateId: string): HookCall[] => hook.calls.filter((call) => call.dateId === dateId);

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_waitlist_hook_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  hook.dataSource = dataSource;
  clock = new FixedClock(NOW);
  cqrs = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      TicketingTransactions,
      ApplyCatalogDateFactHandler,
      OpenCapacityTierHandler,
      SetDatePricesHandler,
      SettleDateOutcomesHandler,
      { provide: WaitlistOutcomeHook, useValue: hook },
      { provide: DataSource, useValue: dataSource },
      { provide: CLOCK, useValue: clock },
    ],
  }).compile();
  await cqrs.init();
  commands = cqrs.get(CommandBus);
}, STARTUP_MS);

afterAll(async () => {
  await cqrs?.close();
  await dataSource?.destroy();
  await stack?.stop();
});

describe("the waiting list's ending (D-096)", () => {
  it(
    'is called once per cancelled or interrupted date, in a transaction of its own holding its row',
    async () => {
      const cancelledId = await dateClosedBy(WireDateOutcome.CANCELLED, 3);
      const interruptedId = await dateClosedBy(WireDateOutcome.INTERRUPTED, 3);

      for (let pass = 0; pass < 3; pass += 1) await settle();

      for (const dateId of [cancelledId, interruptedId]) {
        const calls = callsOf(dateId);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.settlementHeld).toBe(true);
        expect((await settlementOf(dateId))?.settled_at).not.toBeNull();
        const marking = await dataSource.query<{ id: string }[]>(
          'SELECT DISTINCT xmin::text AS id FROM seat_order WHERE date_id = $1',
          [dateId],
        );
        expect(marking).toHaveLength(1);
        expect(marking[0]?.id).not.toBe(calls[0]?.transactionId);
      }
    },
    CASE_MS,
  );

  it(
    'failing, is tried again after 10 s, the refunds made meanwhile, the date settled once it passed',
    async () => {
      const dateId = await dateClosedBy(WireDateOutcome.CANCELLED, 2);
      hook.failuresLeft = 2;

      await settle();
      expect(await settlementOf(dateId)).toEqual({
        waitlist_ended_at: null,
        settled_at: null,
        failed_at: new Date(clock.now()),
      });
      const [refunds] = await dataSource.query<{ owed: number }[]>(
        `SELECT count(*)::int AS owed FROM order_refund AS refund
           JOIN seat_order AS placed ON placed.id = refund.order_id
          WHERE placed.date_id = $1 AND refund.reason = $2`,
        [dateId, RefundReason.DATE_CANCELLED],
      );
      expect(refunds?.owed).toBe(2);

      await settle();
      expect(callsOf(dateId)).toHaveLength(1);

      clock.advance(DATE_OUTCOME_RETRY_SECONDS * 1_000);
      await settle();
      expect(callsOf(dateId)).toHaveLength(2);
      expect((await settlementOf(dateId))?.settled_at).toBeNull();

      clock.advance(DATE_OUTCOME_RETRY_SECONDS * 1_000);
      await settle();
      expect(callsOf(dateId)).toHaveLength(3);
      expect(await settlementOf(dateId)).toMatchObject({
        waitlist_ended_at: new Date(clock.now()),
        settled_at: null,
      });

      await settle();
      expect(await settlementOf(dateId)).toMatchObject({
        settled_at: new Date(clock.now()),
        failed_at: null,
      });
      expect(callsOf(dateId)).toHaveLength(3);
    },
    CASE_MS,
  );
});
