import {
  DateOutcome as WireDateOutcome,
  DateSalesCapacitySetSchema,
  DateSalesPricingChangedSchema,
  PriceTier as WirePriceTier,
} from '@arthome-platform/events';
import { RefusalException, type IdempotentRequest } from '@arthome-platform/http-edge';
import { OutboxEvent, Outcome } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { CommandBus, CqrsModule, EventBus, QueryBus, type IEvent } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DateSalesPaneSchema } from '@arthome/contracts/studio-money';
import {
  ApiErrorCode,
  CatalogErrorCode,
  DateOutcome,
  DomainErrorCode,
  FixedClock,
  PriceTier,
  TECHNICAL_PROVISION_THRESHOLD,
  provisionRevisableUntil,
} from '@arthome/core';

import { ApplyCatalogDateFactHandler } from './apply-catalog-date-fact.handler.js';
import { applyCatalogDateMessage } from './catalog-date-messages.js';
import { DateSalesRow } from './date-sales.entity.js';
import { DatePricesSet } from './date-sales.events.js';
import { GetDateTicketsPaneHandler } from './get-date-tickets-pane.handler.js';
import { GetDateTicketsPane } from './get-date-tickets-pane.query.js';
import { OpenCapacityTier } from './open-capacity-tier.command.js';
import { OpenCapacityTierHandler } from './open-capacity-tier.handler.js';
import { SetDatePrices } from './set-date-prices.command.js';
import { SetDatePricesHandler } from './set-date-prices.handler.js';
import type { SetDatePricesBody } from './set-date-prices.schema.js';
import { SetTechnicalProvision } from './set-technical-provision.command.js';
import { SetTechnicalProvisionHandler } from './set-technical-provision.handler.js';
import { CLOCK } from '../clock.js';
import {
  delivered,
  drafted,
  engaged,
  outcomeDeclared,
  rescheduled,
  scheduled,
} from '../itest/catalog-messages.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/**
 * The studio commands against a real Postgres, through the real buses, reading back what each one
 * leaves in the outbox: every row names `ticketing.date_sales` and carries `date_id` as its key.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const NOW = '2026-09-27T10:00:00.000Z';
const CHANNEL = 'channel-sales-itest';

let stack: StartedStack;
let dataSource: DataSource;
let cqrs: TestingModule;
let commands: CommandBus;
let queries: QueryBus;
let keys = 0;
let dates = 0;

function idempotency(fingerprint: string): IdempotentRequest {
  keys += 1;
  return {
    key: `01a0f2ff-0000-7000-8000-${String(keys).padStart(12, '0')}`,
    accountId: null,
    fingerprint,
    statusCode: 200,
  };
}

/** A date catalog drafted, so ticketing opened its sale, as the consumer does. */
async function openedDate(): Promise<string> {
  dates += 1;
  const dateId = `01a0f200-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  expect(await applyCatalogDateMessage(commands, delivered(drafted(dateId, CHANNEL, NOW)))).toBe(
    Outcome.APPLIED,
  );
  return dateId;
}

const FULL_AND_REDUCED: SetDatePricesBody['tiers'] = [
  { tier: PriceTier.FULL, amountMinor: 2400, currencyCode: 'EUR', active: true },
  { tier: PriceTier.REDUCED, amountMinor: 1600, currencyCode: 'EUR', active: true },
];

function setPrices(
  dateId: string,
  expectedVersion: number,
  tiers: SetDatePricesBody['tiers'] = FULL_AND_REDUCED,
  key: IdempotentRequest = idempotency(`${dateId}:prices:${String(expectedVersion)}`),
) {
  return commands.execute(new SetDatePrices(dateId, { expectedVersion, tiers }, null, key));
}

function openTier(dateId: string, expectedVersion: number, additionalCapacity: number) {
  return commands.execute(
    new OpenCapacityTier(
      dateId,
      { expectedVersion, additionalCapacity, notifyWaitlist: true },
      null,
      idempotency(`${dateId}:tier:${String(expectedVersion)}`),
    ),
  );
}

function setProvision(dateId: string, expectedVersion: number, provisionedCapacity: number) {
  return commands.execute(
    new SetTechnicalProvision(
      dateId,
      { expectedVersion, provisionedCapacity },
      null,
      idempotency(`${dateId}:provision:${String(expectedVersion)}`),
    ),
  );
}

async function refusalOf(attempt: Promise<unknown>): Promise<RefusalException> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof RefusalException) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

/**
 * In the order they were written: `created_at` is each fact's own instant, catalog's for a lock,
 *   and the UUIDv7 ids are minted in sequence.
 */
function outboxRowsFor(dateId: string): Promise<OutboxEvent[]> {
  return dataSource.getRepository(OutboxEvent).find({
    where: { aggregateid: dateId },
    order: { id: 'ASC' },
  });
}

function rowOf(dateId: string): Promise<DateSalesRow> {
  return dataSource.getRepository(DateSalesRow).findOneByOrFail({ date_id: dateId });
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_date_sales_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  cqrs = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      TicketingTransactions,
      ApplyCatalogDateFactHandler,
      GetDateTicketsPaneHandler,
      OpenCapacityTierHandler,
      SetDatePricesHandler,
      SetTechnicalProvisionHandler,
      { provide: DataSource, useValue: dataSource },
      { provide: CLOCK, useValue: new FixedClock(NOW) },
    ],
  }).compile();
  // Handlers register with the buses when the module initialises.
  await cqrs.init();
  commands = cqrs.get(CommandBus);
  queries = cqrs.get(QueryBus);
}, STARTUP_MS);

afterAll(async () => {
  await cqrs?.close();
  await dataSource?.destroy();
  await stack?.stop();
});

describe('setDatePrices', () => {
  it(
    'sets the prices from the version read, and states them on the date’s topic',
    async () => {
      const dateId = await openedDate();

      const response = await setPrices(dateId, 1);

      expect(response.replayed).toBe(false);
      expect(response.envelope).toMatchObject({ servedAt: NOW, version: 2 });
      expect(DateSalesPaneSchema.safeParse(response.envelope.data).success).toBe(true);
      expect(response.envelope.data).toMatchObject({
        dateId,
        pricesLocked: false,
        priceTiers: [
          {
            tier: PriceTier.FULL,
            amount: { amountMinor: 2400, currencyCode: 'EUR' },
            active: true,
          },
          { tier: PriceTier.REDUCED, amount: { amountMinor: 1600, currencyCode: 'EUR' } },
        ],
        version: 2,
      });

      const [row] = await outboxRowsFor(dateId);
      expect(row).toMatchObject({
        aggregatetype: 'ticketing.date_sales',
        aggregateid: dateId,
        type: 'ticketing.date_sales.pricing_changed.v1',
      });
      const payload = fromBinary(DateSalesPricingChangedSchema, row?.payload ?? Buffer.alloc(0));
      expect(payload.pricesLocked).toBe(false);
      expect(payload.channelId).toBe(CHANNEL);
      expect(payload.tiers.map(({ tier, amount }) => [tier, amount?.amountMinor])).toEqual([
        [WirePriceTier.FULL, 2400n],
        [WirePriceTier.REDUCED, 1600n],
      ]);
      expect(payload.occurredAt && timestampDate(payload.occurredAt).toISOString()).toBe(NOW);
      expect((await rowOf(dateId)).availability_moves).toBe('1');
    },
    CASE_MS,
  );

  it(
    'answers a replay with the first response, and writes nothing a second time',
    async () => {
      const dateId = await openedDate();
      const key = idempotency(`${dateId}:replayed`);
      const first = await setPrices(dateId, 1, FULL_AND_REDUCED, key);

      const again = await setPrices(dateId, 1, FULL_AND_REDUCED, key);

      expect(again.replayed).toBe(true);
      expect(again.envelope).toEqual(first.envelope);
      expect(await outboxRowsFor(dateId)).toHaveLength(1);
      expect((await rowOf(dateId)).version).toBe(2);
    },
    CASE_MS,
  );

  it(
    'refuses a key sent again with another body',
    async () => {
      const dateId = await openedDate();
      const key = idempotency(`${dateId}:reused`);
      await setPrices(dateId, 1, FULL_AND_REDUCED, key);

      const refusal = await refusalOf(
        setPrices(dateId, 1, FULL_AND_REDUCED, { ...key, fingerprint: 'another body' }),
      );

      expect(refusal.getStatus()).toBe(409);
      expect(refusal.refusal.code).toBe(ApiErrorCode.IDEMPOTENCY_KEY_REUSED);
    },
    CASE_MS,
  );

  it(
    'refuses two currencies in one sale, and writes nothing',
    async () => {
      const dateId = await openedDate();
      const [full, reduced] = FULL_AND_REDUCED;
      if (full === undefined || reduced === undefined) throw new Error('two tiers');

      const refusal = await refusalOf(
        setPrices(dateId, 1, [full, { ...reduced, currencyCode: 'CHF' }]),
      );

      expect(refusal.getStatus()).toBe(409);
      expect(refusal.refusal).toMatchObject({
        code: CatalogErrorCode.PRICES_CURRENCY_MISMATCH,
        params: { tier: PriceTier.REDUCED, currency: 'CHF', expected: 'EUR' },
      });
      expect(await outboxRowsFor(dateId)).toHaveLength(0);
      expect((await rowOf(dateId)).version).toBe(1);
    },
    CASE_MS,
  );

  it(
    'refuses a stale version, naming the current one, and writes nothing',
    async () => {
      const dateId = await openedDate();
      await setPrices(dateId, 1);

      const refusal = await refusalOf(setPrices(dateId, 1));

      expect(refusal.getStatus()).toBe(409);
      expect(refusal.refusal).toMatchObject({
        code: DomainErrorCode.STATE_CONFLICT,
        params: { version: 2 },
      });
      expect(await outboxRowsFor(dateId)).toHaveLength(1);
    },
    CASE_MS,
  );

  it(
    'lets one of two commands from the same version through, and refuses the other',
    async () => {
      const dateId = await openedDate();

      const outcomes = await Promise.allSettled([setPrices(dateId, 1), setPrices(dateId, 1)]);

      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      const [rejected] = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      expect(rejected?.reason).toBeInstanceOf(RefusalException);
      expect((rejected?.reason as RefusalException).refusal).toMatchObject({
        code: DomainErrorCode.STATE_CONFLICT,
        params: { version: 2 },
      });
      expect((await rowOf(dateId)).version).toBe(2);
    },
    CASE_MS,
  );

  it(
    'refuses once the sale opened, naming when, and the lock states the prices once more',
    async () => {
      const dateId = await openedDate();
      await setPrices(dateId, 1);
      const openedAt = '2026-09-27T11:00:00.000Z';
      expect(await applyCatalogDateMessage(commands, delivered(engaged(dateId, openedAt)))).toBe(
        Outcome.APPLIED,
      );

      const refusal = await refusalOf(setPrices(dateId, 3));

      expect(refusal.getStatus()).toBe(409);
      expect(refusal.refusal).toMatchObject({
        code: CatalogErrorCode.PRICES_LOCKED,
        params: { lockedAt: openedAt },
      });
      const rows = await outboxRowsFor(dateId);
      expect(rows.map(({ type }) => type)).toEqual([
        'ticketing.date_sales.pricing_changed.v1',
        'ticketing.date_sales.pricing_changed.v1',
      ]);
      expect(
        fromBinary(DateSalesPricingChangedSchema, rows[1]?.payload ?? Buffer.alloc(0)),
      ).toMatchObject({ pricesLocked: true });
    },
    CASE_MS,
  );

  it(
    'publishes its domain event once committed, and none for a replay or a refusal',
    async () => {
      const dateId = await openedDate();
      const events: IEvent[] = [];
      const subscription = cqrs.get(EventBus).subscribe((event) => events.push(event));
      try {
        const key = idempotency(`${dateId}:events`);
        await setPrices(dateId, 1, FULL_AND_REDUCED, key);
        await setPrices(dateId, 1, FULL_AND_REDUCED, key);
        await refusalOf(setPrices(dateId, 1));

        expect(events.map((event) => event.constructor)).toEqual([DatePricesSet]);
      } finally {
        subscription.unsubscribe();
      }
    },
    CASE_MS,
  );
});

describe('openCapacityTier', () => {
  it(
    'sets the first capacity, widens it by tiers, and states each on capacity_set',
    async () => {
      const dateId = await openedDate();

      const first = await openTier(dateId, 1, 200);
      const second = await openTier(dateId, 2, 50);

      expect(first.envelope).toMatchObject({ version: 2, data: { waitlistNotified: 0 } });
      expect(second.envelope.data.sales).toMatchObject({
        capacityTotal: 250,
        seatsAvailable: 250,
        capacityTiers: [{ capacity: 200 }, { capacity: 50 }],
        technicalProvision: { required: false, threshold: TECHNICAL_PROVISION_THRESHOLD },
        version: 3,
      });
      expect(second.envelope.data).not.toHaveProperty('priorityUntil');
      const payloads = (await outboxRowsFor(dateId)).map(({ type, payload }) => {
        expect(type).toBe('ticketing.date_sales.capacity_set.v1');
        return fromBinary(DateSalesCapacitySetSchema, payload);
      });
      expect(payloads.map(({ capacityTotal }) => capacityTotal)).toEqual([200, 250]);
      expect(payloads[0]?.technicalProvisionRequired).toBe(false);
      expect(payloads[0]?.provisionRevisableUntil).toBeUndefined();
    },
    CASE_MS,
  );

  it(
    'states no deadline on a capacity no provision concerns, which the pane still serves',
    async () => {
      const dateId = await openedDate();
      const startsAt = '2026-12-12T19:00:00.000Z';
      await applyCatalogDateMessage(commands, delivered(scheduled(dateId, startsAt, NOW)));

      const opened = await openTier(dateId, 2, 300);
      await applyCatalogDateMessage(
        commands,
        delivered(rescheduled(dateId, '2026-12-19T19:00:00.000Z', '2026-09-28T10:00:00.000Z')),
      );

      expect(opened.envelope.data.sales.technicalProvision).toMatchObject({
        required: false,
        provisionedCapacity: null,
        revisableUntil: provisionRevisableUntil(startsAt),
      });
      const [stated, ...restated] = await outboxRowsFor(dateId);
      expect(restated).toEqual([]);
      expect(
        fromBinary(DateSalesCapacitySetSchema, stated?.payload ?? Buffer.alloc(0))
          .provisionRevisableUntil,
      ).toBeUndefined();
    },
    CASE_MS,
  );

  it(
    'keeps what a hold took between the load and the save: the counters move by a delta',
    async () => {
      const dateId = await openedDate();
      await openTier(dateId, 1, 100);

      await cqrs.get(TicketingTransactions).run(async ({ manager, dateSales }) => {
        const sales = await dateSales.findById(dateId);
        if (sales === null) throw new Error('no sale');
        // The hot decrement's shape (adr-ticketing.md §2), leaving the version as it was.
        await manager.query(
          'UPDATE date_sales SET seats_available = seats_available - 5 WHERE date_id = $1',
          [dateId],
        );
        sales.openCapacityTier(2, 10, NOW);
        await dateSales.save(sales);
      });

      const row = await rowOf(dateId);
      expect(row.capacity_total).toBe(110);
      expect(row.seats_available).toBe(105);
    },
    CASE_MS,
  );

  it(
    'refuses a capacity past the threshold no provision covers, and writes nothing',
    async () => {
      const dateId = await openedDate();
      const startsAt = '2026-12-12T19:00:00.000Z';
      await applyCatalogDateMessage(commands, delivered(scheduled(dateId, startsAt, NOW)));

      const refusal = await refusalOf(openTier(dateId, 2, TECHNICAL_PROVISION_THRESHOLD + 1));

      expect(refusal.getStatus()).toBe(409);
      expect(refusal.refusal).toMatchObject({
        code: CatalogErrorCode.TECHNICAL_PROVISION_REQUIRED,
        params: {
          threshold: TECHNICAL_PROVISION_THRESHOLD,
          capacityTotal: TECHNICAL_PROVISION_THRESHOLD + 1,
          revisableUntil: provisionRevisableUntil(startsAt),
        },
      });
      expect((await rowOf(dateId)).capacity_total).toBe(0);
      expect(await outboxRowsFor(dateId)).toHaveLength(0);
    },
    CASE_MS,
  );

  it(
    'refuses a stale version and a date ticketing never opened',
    async () => {
      const dateId = await openedDate();

      expect((await refusalOf(openTier(dateId, 7, 10))).refusal.code).toBe(
        DomainErrorCode.STATE_CONFLICT,
      );
      const unknown = await refusalOf(openTier('01a0f2aa-0000-7000-8000-000000000001', 1, 10));
      expect(unknown.getStatus()).toBe(404);
    },
    CASE_MS,
  );
});

describe('setTechnicalProvision', () => {
  it(
    'records a provision, opens a tier past the threshold it covers, and states both on capacity_set',
    async () => {
      const dateId = await openedDate();
      const startsAt = '2026-12-12T19:00:00.000Z';
      const movedTo = '2026-12-19T19:00:00.000Z';
      await applyCatalogDateMessage(commands, delivered(scheduled(dateId, startsAt, NOW)));

      const provisioned = await setProvision(dateId, 2, 15_000);
      const opened = await openTier(dateId, 3, 12_000);
      await applyCatalogDateMessage(
        commands,
        delivered(rescheduled(dateId, movedTo, '2026-09-28T10:00:00.000Z')),
      );

      expect(provisioned.envelope).toMatchObject({ version: 3 });
      expect(DateSalesPaneSchema.safeParse(provisioned.envelope.data).success).toBe(true);
      expect(provisioned.envelope.data.technicalProvision).toEqual({
        required: false,
        threshold: TECHNICAL_PROVISION_THRESHOLD,
        provisionedCapacity: 15_000,
        revisableUntil: provisionRevisableUntil(startsAt),
      });
      expect(opened.envelope.data.sales).toMatchObject({
        capacityTotal: 12_000,
        technicalProvision: { required: true, provisionedCapacity: 15_000 },
      });
      const stated = (await outboxRowsFor(dateId)).map(({ type, payload }) => {
        expect(type).toBe('ticketing.date_sales.capacity_set.v1');
        const event = fromBinary(DateSalesCapacitySetSchema, payload);
        return [
          event.capacityTotal,
          event.technicalProvisionRequired,
          event.provisionedCapacity,
          event.provisionRevisableUntil &&
            timestampDate(event.provisionRevisableUntil).toISOString(),
        ];
      });
      expect(stated).toEqual([
        [0, false, 15_000, provisionRevisableUntil(startsAt)],
        [12_000, true, 15_000, provisionRevisableUntil(startsAt)],
        [12_000, true, 15_000, provisionRevisableUntil(movedTo)],
      ]);
    },
    CASE_MS,
  );

  it(
    'refuses a provision past its deadline, and one below the capacity already open',
    async () => {
      const soon = await openedDate();
      await applyCatalogDateMessage(
        commands,
        delivered(scheduled(soon, '2026-09-29T19:00:00.000Z', NOW)),
      );
      const open = await openedDate();
      await openTier(open, 1, 500);

      const late = await refusalOf(setProvision(soon, 2, 15_000));
      const below = await refusalOf(setProvision(open, 2, 400));

      expect(late.getStatus()).toBe(409);
      expect(late.refusal).toMatchObject({
        code: CatalogErrorCode.PROVISION_DEADLINE_PASSED,
        params: { revisableUntil: '2026-09-26T19:00:00.000Z' },
      });
      expect(below.refusal).toMatchObject({
        code: CatalogErrorCode.PROVISION_BELOW_CAPACITY,
        params: { capacityTotal: 500, provisionedCapacity: 400 },
      });
      expect((await rowOf(open)).provisioned_capacity).toBeNull();
    },
    CASE_MS,
  );
});

describe('a sale an outcome closed', () => {
  it(
    'refuses a new tier with the outcome that closed it',
    async () => {
      const dateId = await openedDate();
      await openTier(dateId, 1, 50);
      await applyCatalogDateMessage(commands, delivered(engaged(dateId, NOW)));
      await applyCatalogDateMessage(
        commands,
        delivered(outcomeDeclared(dateId, WireDateOutcome.CANCELLED, NOW)),
      );

      const refusal = await refusalOf(openTier(dateId, 4, 10));

      expect(refusal.getStatus()).toBe(409);
      expect(refusal.refusal).toMatchObject({
        code: DomainErrorCode.STATE_CONFLICT,
        params: { version: 4, outcome: DateOutcome.CANCELLED },
      });
      expect((await rowOf(dateId)).capacity_total).toBe(50);
    },
    CASE_MS,
  );
});

describe('the outbox', () => {
  it(
    'holds one row per fact, on the date’s key, in the order the facts happened',
    async () => {
      const dateId = await openedDate();
      await openTier(dateId, 1, 80);
      await setPrices(dateId, 2);
      await applyCatalogDateMessage(
        commands,
        delivered(engaged(dateId, '2026-09-27T11:00:00.000Z')),
      );
      await openTier(dateId, 4, 20);

      const rows = await outboxRowsFor(dateId);

      expect(rows.map(({ type }) => type)).toEqual([
        'ticketing.date_sales.capacity_set.v1',
        'ticketing.date_sales.pricing_changed.v1',
        'ticketing.date_sales.pricing_changed.v1',
        'ticketing.date_sales.capacity_set.v1',
      ]);
      expect(new Set(rows.map(({ aggregatetype }) => aggregatetype))).toEqual(
        new Set(['ticketing.date_sales']),
      );
      expect(new Set(rows.map(({ id }) => id)).size).toBe(4);
      expect(
        rows.map(({ type, payload }) =>
          type === 'ticketing.date_sales.capacity_set.v1'
            ? fromBinary(DateSalesCapacitySetSchema, payload).capacityTotal
            : fromBinary(DateSalesPricingChangedSchema, payload).pricesLocked,
        ),
      ).toEqual([80, false, true, 100]);
    },
    CASE_MS,
  );
});

describe('getDateTicketsPane', () => {
  it(
    'serves the pane the contract describes, the counters as they stand',
    async () => {
      const dateId = await openedDate();
      await openTier(dateId, 1, 40);
      await setPrices(dateId, 2);
      await dataSource.query(
        'UPDATE date_sales SET seats_available = 4, seats_sold = 34 WHERE date_id = $1',
        [dateId],
      );

      const pane = await queries.execute(new GetDateTicketsPane(dateId));

      expect(DateSalesPaneSchema.safeParse(pane).success).toBe(true);
      expect(pane).toMatchObject({
        capacityTotal: 40,
        seatsAvailable: 4,
        seatsSold: 34,
        fillRateBps: 8500,
        waitlistCount: 0,
        version: 3,
      });
      expect(pane).not.toHaveProperty('grossRevenue');
      expect(pane).not.toHaveProperty('serviceFeePerSeat');
    },
    CASE_MS,
  );
});
