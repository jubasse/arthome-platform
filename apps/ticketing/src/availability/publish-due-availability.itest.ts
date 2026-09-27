import { DateSalesAvailabilityChangedSchema } from '@arthome-platform/events';
import { OutboxEvent } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AVAILABILITY_PUBLISH_MIN_INTERVAL_SECONDS, FixedClock, PriceTier } from '@arthome/core';

import { PublishDueAvailability } from './publish-due-availability.command.js';
import { PublishDueAvailabilityHandler } from './publish-due-availability.handler.js';
import { CLOCK } from '../clock.js';
import { ApplyCatalogDateFactHandler } from '../date-sales/apply-catalog-date-fact.handler.js';
import { applyCatalogDateMessage } from '../date-sales/catalog-date-messages.js';
import { OpenCapacityTier } from '../date-sales/open-capacity-tier.command.js';
import { OpenCapacityTierHandler } from '../date-sales/open-capacity-tier.handler.js';
import { SetDatePrices } from '../date-sales/set-date-prices.command.js';
import { SetDatePricesHandler } from '../date-sales/set-date-prices.handler.js';
import { delivered, drafted, engaged } from '../itest/catalog-messages.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/**
 * adr-ticketing.md §5 against a real Postgres, the clock driven by the suite: a date that keeps
 * moving is published at most every `AVAILABILITY_PUBLISH_MIN_INTERVAL_SECONDS`, selling out and
 * coming back at once, and two publishers never publish one date twice.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const CHANNEL = 'channel-publisher-itest';
const INTERVAL_MS = AVAILABILITY_PUBLISH_MIN_INTERVAL_SECONDS * 1_000;

let stack: StartedStack;
let dataSource: DataSource;
let cqrs: TestingModule;
let commands: CommandBus;
let clock: FixedClock;
let keys = 0;
let dates = 0;

function idempotency(fingerprint: string) {
  keys += 1;
  return {
    key: `01a0f5ff-0000-7000-8000-${String(keys).padStart(12, '0')}`,
    accountId: null,
    fingerprint,
    statusCode: 200,
  };
}

/** Drafted, one tier, a price, then opened: the opening is its first move to publish. */
async function openSale(capacity: number): Promise<string> {
  dates += 1;
  const dateId = `01a0f500-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await applyCatalogDateMessage(commands, delivered(drafted(dateId, CHANNEL, clock.now())));
  await commands.execute(
    new OpenCapacityTier(
      dateId,
      { expectedVersion: 1, additionalCapacity: capacity, notifyWaitlist: true },
      null,
      idempotency(`${dateId}:tier`),
    ),
  );
  await commands.execute(
    new SetDatePrices(
      dateId,
      {
        expectedVersion: 2,
        tiers: [
          { tier: PriceTier.FULL, amountMinor: 2400, currencyCode: 'EUR', active: true },
          { tier: PriceTier.REDUCED, amountMinor: 1600, currencyCode: 'EUR', active: true },
        ],
      },
      null,
      idempotency(`${dateId}:prices`),
    ),
  );
  await applyCatalogDateMessage(commands, delivered(engaged(dateId, clock.now())));
  return dateId;
}

/** The hot decrement's shape (adr-ticketing.md §2), and a hold returning its seats. */
async function move(dateId: string, taken: number): Promise<void> {
  await dataSource.query(
    `UPDATE date_sales
        SET seats_available = seats_available - $2,
            availability_dirty_since = COALESCE(availability_dirty_since, now())
      WHERE date_id = $1`,
    [dateId, taken],
  );
}

function publish(): Promise<number> {
  return commands.execute(new PublishDueAvailability());
}

async function published(dateId: string) {
  const rows = await dataSource.getRepository(OutboxEvent).find({
    where: { aggregateid: dateId, type: 'ticketing.date_sales.availability_changed.v1' },
    order: { created_at: 'ASC', id: 'ASC' },
  });
  return rows.map((row) => ({
    row,
    event: fromBinary(DateSalesAvailabilityChangedSchema, row.payload),
  }));
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_publisher_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  clock = new FixedClock('2026-09-27T10:00:00.000Z');
  cqrs = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      TicketingTransactions,
      ApplyCatalogDateFactHandler,
      OpenCapacityTierHandler,
      PublishDueAvailabilityHandler,
      SetDatePricesHandler,
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

describe('the availability publisher', () => {
  it(
    'publishes a moving date at most once per interval, with its latest figures',
    async () => {
      const dateId = await openSale(100);
      const opening = clock.now();
      await publish();

      // A seat every half second for twelve seconds, a pass after each.
      for (let tick = 1; tick <= 24; tick += 1) {
        clock.advance(500);
        await move(dateId, 1);
        await publish();
      }
      clock.advance(INTERVAL_MS);
      await publish();

      const events = await published(dateId);
      const instants = events.map(({ row }) => row.created_at.toISOString());
      expect(instants).toEqual([
        opening,
        '2026-09-27T10:00:05.000Z',
        '2026-09-27T10:00:10.000Z',
        '2026-09-27T10:00:17.000Z',
      ]);
      expect(events.map(({ event }) => event.seatsAvailable)).toEqual([100, 90, 80, 76]);
      const last = events.at(-1)?.event;
      expect(last).toMatchObject({ dateId, channelId: CHANNEL, fillRateBps: 0, soldOut: false });
      expect(last?.lowestPrice).toMatchObject({ amountMinor: 1600n, currencyCode: 'EUR' });
      expect(last?.occurredAt && timestampDate(last.occurredAt).toISOString()).toBe(
        '2026-09-27T10:00:17.000Z',
      );
      expect(events.at(-1)?.row).toMatchObject({
        aggregatetype: 'ticketing.date_sales',
        tracecontext: null,
      });
      expect(await publish()).toBe(0);
    },
    CASE_MS,
  );

  it(
    'publishes selling out and coming back from it at once, whatever the interval',
    async () => {
      const dateId = await openSale(3);
      await publish();

      clock.advance(1_000);
      await move(dateId, 3);
      await publish();
      clock.advance(1_000);
      await move(dateId, -1);
      await publish();
      clock.advance(1_000);
      await move(dateId, -1);
      await publish();

      const events = await published(dateId);
      expect(events.map(({ event }) => [event.seatsAvailable, event.soldOut])).toEqual([
        [3, false],
        [0, true],
        [1, false],
      ]);
      // The third move crossed nothing: it waits for the interval.
      expect(
        (
          await dataSource.query<{ dirty: boolean }[]>(
            'SELECT availability_dirty_since IS NOT NULL AS dirty FROM date_sales WHERE date_id = $1',
            [dateId],
          )
        )[0]?.dirty,
      ).toBe(true);
    },
    CASE_MS,
  );

  it(
    'publishes nothing for a draft, and its first figures when the sale opens',
    async () => {
      dates += 1;
      const dateId = `01a0f500-0000-7000-8000-${String(dates).padStart(12, '0')}`;
      await applyCatalogDateMessage(commands, delivered(drafted(dateId, CHANNEL, clock.now())));
      await commands.execute(
        new OpenCapacityTier(
          dateId,
          { expectedVersion: 1, additionalCapacity: 10, notifyWaitlist: true },
          null,
          idempotency(`${dateId}:tier`),
        ),
      );

      await publish();
      expect(await published(dateId)).toHaveLength(0);

      await applyCatalogDateMessage(commands, delivered(engaged(dateId, clock.now())));
      await publish();
      const [opening] = await published(dateId);
      expect(opening?.event).toMatchObject({ seatsAvailable: 10, soldOut: false });
      expect(opening?.event.lowestPrice).toBeUndefined();
    },
    CASE_MS,
  );

  it(
    'skips a date another transaction holds, and never publishes one date twice at once',
    async () => {
      const held = await openSale(20);
      const free = await openSale(20);
      const holder = dataSource.createQueryRunner();
      await holder.connect();
      await holder.startTransaction();
      try {
        await holder.query('SELECT 1 FROM date_sales WHERE date_id = $1 FOR UPDATE', [held]);
        await publish();
        expect(await published(held)).toHaveLength(0);
        expect(await published(free)).toHaveLength(1);
      } finally {
        await holder.rollbackTransaction();
        await holder.release();
      }

      const racing = await Promise.all([openSale(5), openSale(5), openSale(5)]);
      const passes = await Promise.all([publish(), publish(), publish(), publish()]);
      expect(passes.reduce((sum, count) => sum + count, 0)).toBe(4);
      for (const dateId of [held, ...racing]) expect(await published(dateId)).toHaveLength(1);
    },
    CASE_MS,
  );
});
