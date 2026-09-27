import {
  DateOutcome as WireDateOutcome,
  DateSalesAvailabilityChangedSchema,
} from '@arthome-platform/events';
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

import { DateAvailabilityPublicationRow } from './date-availability-publication.entity.js';
import { PublishDueAvailability } from './publish-due-availability.command.js';
import {
  AVAILABILITY_PUBLISH_RETRY_SECONDS,
  PublishDueAvailabilityHandler,
} from './publish-due-availability.handler.js';
import { CLOCK } from '../clock.js';
import { ApplyCatalogDateFactHandler } from '../date-sales/apply-catalog-date-fact.handler.js';
import { applyCatalogDateMessage } from '../date-sales/catalog-date-messages.js';
import { OpenCapacityTier } from '../date-sales/open-capacity-tier.command.js';
import { OpenCapacityTierHandler } from '../date-sales/open-capacity-tier.handler.js';
import { SetDatePrices } from '../date-sales/set-date-prices.command.js';
import { SetDatePricesHandler } from '../date-sales/set-date-prices.handler.js';
import { delivered, drafted, engaged, outcomeDeclared } from '../itest/catalog-messages.js';
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

/** The hot decrement's shape (adr-ticketing.md §2), counting itself; a negative one returns seats. */
const MOVE = `UPDATE date_sales
                 SET seats_available = seats_available - $2,
                     availability_moves = availability_moves + 1
               WHERE date_id = $1`;

async function move(dateId: string, taken: number): Promise<void> {
  await dataSource.query(MOVE, [dateId, taken]);
}

async function unpublishedMoves(dateId: string): Promise<number> {
  const [row] = await dataSource.query<{ behind: number }[]>(
    `SELECT (sales.availability_moves - publication.published_moves)::int AS behind
       FROM date_sales AS sales
       JOIN date_availability_publication AS publication USING (date_id)
      WHERE date_id = $1`,
    [dateId],
  );
  return row?.behind ?? 0;
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
      expect(await unpublishedMoves(dateId)).toBe(1);
    },
    CASE_MS,
  );

  it(
    'publishes a closing as no seat and not sold out, and a sold-out closing at once',
    async () => {
      const dateId = await openSale(10);
      await publish();

      clock.advance(1_000);
      await applyCatalogDateMessage(
        commands,
        delivered(outcomeDeclared(dateId, WireDateOutcome.CANCELLED, clock.now())),
      );
      await publish();
      expect(await published(dateId)).toHaveLength(1);
      clock.advance(INTERVAL_MS);
      await publish();

      expect(
        (await published(dateId)).map(({ event }) => [event.seatsAvailable, event.soldOut]),
      ).toEqual([
        [10, false],
        [0, false],
      ]);
      expect(await publish()).toBe(0);

      const soldOut = await openSale(2);
      await move(soldOut, 2);
      await publish();
      clock.advance(1_000);
      await applyCatalogDateMessage(
        commands,
        delivered(outcomeDeclared(soldOut, WireDateOutcome.INTERRUPTED, clock.now())),
      );
      await publish();
      expect(
        (await published(soldOut)).map(({ event }) => [event.seatsAvailable, event.soldOut]),
      ).toEqual([
        [0, true],
        [0, false],
      ]);
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
    'publishes a date a command holds without waiting for it, and skips one another pass holds',
    async () => {
      const heldByCommand = await openSale(20);
      const heldByPublisher = await openSale(20);
      const command = dataSource.createQueryRunner();
      const publisher = dataSource.createQueryRunner();
      await command.connect();
      await publisher.connect();
      await command.startTransaction();
      await publisher.startTransaction();
      try {
        await command.query('SELECT 1 FROM date_sales WHERE date_id = $1 FOR UPDATE', [
          heldByCommand,
        ]);
        await publisher.query(
          'SELECT 1 FROM date_availability_publication WHERE date_id = $1 FOR UPDATE',
          [heldByPublisher],
        );
        await publish();
        expect(await published(heldByCommand)).toHaveLength(1);
        expect(await published(heldByPublisher)).toHaveLength(0);
      } finally {
        await command.rollbackTransaction();
        await publisher.rollbackTransaction();
        await command.release();
        await publisher.release();
      }
      await publish();
      expect(await published(heldByPublisher)).toHaveLength(1);

      const racing = await Promise.all([openSale(5), openSale(5), openSale(5)]);
      const passes = await Promise.all([publish(), publish(), publish(), publish()]);
      expect(passes.reduce((sum, count) => sum + count, 0)).toBe(3);
      for (const dateId of racing) expect(await published(dateId)).toHaveLength(1);
    },
    CASE_MS,
  );

  it(
    'never makes a move wait for a publication, and never loses one made during it',
    async () => {
      const dateId = await openSale(30);
      // Holds the publication between its read of the figures and its commit.
      await dataSource.query(
        `CREATE FUNCTION slow_publication_itest() RETURNS trigger LANGUAGE plpgsql AS
           $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$`,
      );
      await dataSource.query(
        `CREATE TRIGGER slow_publication_itest BEFORE INSERT ON outbox_event FOR EACH ROW
           WHEN (NEW.aggregateid = '${dateId}') EXECUTE FUNCTION slow_publication_itest()`,
      );
      try {
        const pass = publish();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const started = performance.now();
        await move(dateId, 2);
        expect(performance.now() - started).toBeLessThan(100);
        expect(await pass).toBe(1);
      } finally {
        await dataSource.query('DROP TRIGGER slow_publication_itest ON outbox_event');
        await dataSource.query('DROP FUNCTION slow_publication_itest()');
      }

      expect((await published(dateId)).map(({ event }) => event.seatsAvailable)).toEqual([30]);
      expect(await unpublishedMoves(dateId)).toBe(1);
      clock.advance(INTERVAL_MS);
      await publish();
      expect((await published(dateId)).map(({ event }) => event.seatsAvailable)).toEqual([30, 28]);
      expect(await unpublishedMoves(dateId)).toBe(0);
    },
    CASE_MS,
  );

  it(
    'lets a hold on the last date of a hundred-date pass through at once',
    async () => {
      const dates = await Promise.all(Array.from({ length: 100 }, () => openSale(500)));
      await publish();
      clock.advance(INTERVAL_MS);
      for (const dateId of dates) await move(dateId, 1);
      const hot = dates.at(-1) ?? '';

      const passStarted = performance.now();
      const pass = publish();
      await new Promise((resolve) => setTimeout(resolve, 2));
      const holdStarted = performance.now();
      await dataSource.query(`${MOVE} AND on_sale AND seats_available >= $2`, [hot, 1]);
      const holdMs = performance.now() - holdStarted;
      expect(await pass).toBe(100);
      const passMs = performance.now() - passStarted;

      process.stdout.write(
        `hold behind a 100-date pass: waited ${holdMs.toFixed(1)} ms, pass ${passMs.toFixed(1)} ms\n`,
      );
      expect(holdMs).toBeLessThan(20);
    },
    CASE_MS,
  );

  it(
    'sets aside a date it cannot publish, publishes the others, and tries it again later',
    async () => {
      const healthy = await openSale(10);
      await publish();
      const broken = await openSale(10);
      // A price core refuses to read: no validated write stores one, a hand edit could.
      await dataSource.query(
        `UPDATE date_sales
            SET price_tiers = '[{"tier":"full","amountMinor":1.5,"currencyCode":"EUR","active":true}]'
          WHERE date_id = $1`,
        [broken],
      );
      clock.advance(INTERVAL_MS);
      await move(healthy, 1);
      const failedAt = async () =>
        (
          await dataSource.getRepository(DateAvailabilityPublicationRow).findOneByOrFail({
            date_id: broken,
          })
        ).failed_at?.toISOString() ?? null;

      // The broken date sorts first, never published, and the healthy one is published after it.
      await publish();
      expect(await published(healthy)).toHaveLength(2);
      expect(await published(broken)).toHaveLength(0);
      const firstFailure = clock.now();
      expect(await failedAt()).toBe(firstFailure);

      clock.advance(1_000);
      await publish();
      expect(await failedAt()).toBe(firstFailure);

      clock.advance(AVAILABILITY_PUBLISH_RETRY_SECONDS * 1_000);
      await publish();
      expect(await failedAt()).toBe(clock.now());

      await dataSource.query(`UPDATE date_sales SET price_tiers = '[]' WHERE date_id = $1`, [
        broken,
      ]);
      clock.advance(AVAILABILITY_PUBLISH_RETRY_SECONDS * 1_000);
      await publish();
      expect(await published(broken)).toHaveLength(1);
      expect(await failedAt()).toBeNull();
    },
    CASE_MS,
  );

  it(
    'looks at the live sales and the pending closings, not at the history',
    async () => {
      const history = 50_000;
      await dataSource.query(
        `WITH sold AS (
           INSERT INTO date_sales (date_id, channel_id, capacity_total, capacity_tiers,
                                   seats_available, seats_sold, waitlist_count, price_tiers,
                                   prices_locked_at, sales_closed_at, version, availability_moves)
           SELECT gen_random_uuid(), 'channel-history', 100, '[]', 0, 100, 0, '[]',
                  now(), now(), 4, 3
             FROM generate_series(1, $1)
           RETURNING date_id
         )
         INSERT INTO date_availability_publication
                (date_id, published_moves, published_at, published_sold_out)
         SELECT date_id, 3, now(), false FROM sold`,
        [history],
      );
      await dataSource.query('ANALYZE date_sales, date_availability_publication');
      await publish();

      const passes: number[] = [];
      for (let run = 0; run < 5; run += 1) {
        const started = performance.now();
        await publish();
        passes.push(performance.now() - started);
      }
      process.stdout.write(
        `idle pass over ${String(history)} dates of history: ${passes.map((ms) => ms.toFixed(1)).join(', ')} ms\n`,
      );
      expect(Math.min(...passes)).toBeLessThan(10);
    },
    CASE_MS * 2,
  );
});
