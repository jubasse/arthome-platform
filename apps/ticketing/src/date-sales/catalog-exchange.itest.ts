import {
  ChatMode,
  DateChatPolicyChangedSchema,
  TechnicalCheckPassedSchema,
} from '@arthome-platform/events';
import type { IdempotentRequest } from '@arthome-platform/http-edge';
import { OutboxEvent, Outcome } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { CommandBus, CqrsModule, QueryBus } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import type { EachMessagePayload } from 'kafkajs';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CatalogErrorCode,
  FixedClock,
  LanguageDependency,
  PriceTier,
  PublicationChecklistItem,
  PublicationPromise,
  PublicationState,
  ReplayPolicy,
} from '@arthome/core';

import { ApplyCatalogDateFactHandler } from './apply-catalog-date-fact.handler.js';
import { applyCatalogDateMessage } from './catalog-date-messages.js';
import { DateSalesRow } from './date-sales.entity.js';
import { OpenCapacityTier } from './open-capacity-tier.command.js';
import { OpenCapacityTierHandler } from './open-capacity-tier.handler.js';
import { SetDatePrices } from './set-date-prices.command.js';
import { SetDatePricesHandler } from './set-date-prices.handler.js';
import { Show } from '../../../catalog/src/catalog/show.entity.js';
import { CatalogTransactions } from '../../../catalog/src/catalog-transactions.js';
import { CLOCK as CATALOG_CLOCK } from '../../../catalog/src/clock.js';
import { applyChecklistMessage } from '../../../catalog/src/dates/checklist-consumer.js';
import { DraftDate } from '../../../catalog/src/dates/draft-date.command.js';
import { DraftDateHandler } from '../../../catalog/src/dates/draft-date.handler.js';
import { GetDateSheetHandler } from '../../../catalog/src/dates/get-date-sheet.handler.js';
import { GetDateSheet } from '../../../catalog/src/dates/get-date-sheet.query.js';
import { RecordChecklistFactHandler } from '../../../catalog/src/dates/record-checklist-fact.handler.js';
import { TransitionPublication } from '../../../catalog/src/dates/transition-publication.command.js';
import { TransitionPublicationHandler } from '../../../catalog/src/dates/transition-publication.handler.js';
import { CATALOG_SCHEMA } from '../../../catalog/src/itest/schema.js';
import { PUBLIC_WEB_ORIGIN } from '../../../catalog/src/public-web-origin.js';
import { Venue } from '../../../catalog/src/venues/venue.entity.js';
import { CLOCK } from '../clock.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/**
 * Catalog and ticketing read each other's real events: each side's own commands write their
 * outbox rows, each row goes to the other side as Debezium's router shapes it (the column placement
 * of `infra/debezium/*-outbox.json`), and each side's own consumer code reads it. A date is drafted
 * in catalog, opened in ticketing, given a capacity and a price there, published in catalog once
 * ticketing's facts complete its checklist, and its prices lock in ticketing.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const NOW = '2026-09-27T10:00:00.000Z';
const CHANNEL = 'channel-exchange-itest';
const SHOW_ID = '01a0f600-0000-7000-8000-000000000001';
const VENUE_ID = '01a0f600-0000-7000-8000-000000000002';
const DATE_ID = '01a0f600-0000-7000-8000-000000000101';

let stack: StartedStack;
let catalogData: DataSource;
let ticketingData: DataSource;
let catalog: TestingModule;
let ticketing: TestingModule;
let keys = 0;

function idempotency(statusCode: number): IdempotentRequest {
  keys += 1;
  return {
    key: `01a0f6ff-0000-7000-8000-${String(keys).padStart(12, '0')}`,
    accountId: null,
    fingerprint: String(keys),
    statusCode,
  };
}

/** Debezium renders a NULL column as the four characters `null`, which `header()` reads back. */
function routed(row: OutboxEvent): EachMessagePayload {
  const column = (value: string | null): Buffer => Buffer.from(value ?? 'null');
  return {
    topic: `arthome.${row.aggregatetype}`,
    partition: 0,
    message: {
      key: Buffer.from(row.aggregateid),
      value: row.payload,
      headers: {
        'message-id': column(row.id),
        type: column(row.type),
        traceparent: column(row.tracecontext),
        'actor-id': column(row.actor_id),
        'occurred-at': column(row.created_at.toISOString()),
      },
    },
  } as unknown as EachMessagePayload;
}

/** The rows a side wrote since the last read, in the order it wrote them. */
function outboxReader(dataSource: DataSource): () => Promise<OutboxEvent[]> {
  const read = new Set<string>();
  return async () => {
    const rows = await dataSource.getRepository(OutboxEvent).find({
      order: { created_at: 'ASC', id: 'ASC' },
    });
    const unread = rows.filter(({ id }) => !read.has(id));
    for (const { id } of unread) read.add(id);
    return unread;
  };
}

/** A fact another context will report, made by hand: `streaming` and `chat` do not exist yet. */
function reported(type: string, value: Uint8Array): EachMessagePayload {
  keys += 1;
  return {
    topic: 'arthome.elsewhere',
    partition: 0,
    message: {
      key: Buffer.from(DATE_ID),
      value: Buffer.from(value),
      headers: {
        'message-id': Buffer.from(`01a0f6ee-0000-7000-8000-${String(keys).padStart(12, '0')}`),
        type: Buffer.from(type),
      },
    },
  } as unknown as EachMessagePayload;
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  catalogData = await applyMigrations(
    await createDatabase(stack.postgres, 'catalog_exchange_itest'),
    CATALOG_SCHEMA,
  );
  ticketingData = await applyMigrations(
    await createDatabase(stack.postgres, 'ticketing_exchange_itest'),
    TICKETING_SCHEMA,
  );

  await catalogData.getRepository(Show).insert({
    id: SHOW_ID,
    slug: 'port',
    channel_id: CHANNEL,
    artist_id: 'artist-exchange',
    category_id: 'theatre',
    genre_ids: [],
    tag_ids: [],
    runtime_min: 95,
    language_dependency: LanguageDependency.NONE,
    spoken_languages: ['fr-FR'],
    subtitle_languages: [],
    surtitle_languages: [],
    media: {
      wide: [],
      poster: [{ url: 'https://cdn.example.test/p.jpg', widthPx: 480, heightPx: 720 }],
    },
    title: { fr: 'Le port', en: '' },
    synopsis: { fr: 'Un port.', en: '' },
  });
  await catalogData.getRepository(Venue).insert({
    id: VENUE_ID,
    name: 'Salle du port',
    city: 'Marseille',
    country: 'FR',
    time_zone: 'Europe/Paris',
  });

  catalog = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      CatalogTransactions,
      DraftDateHandler,
      GetDateSheetHandler,
      RecordChecklistFactHandler,
      TransitionPublicationHandler,
      { provide: DataSource, useValue: catalogData },
      { provide: CATALOG_CLOCK, useValue: new FixedClock(NOW) },
      { provide: PUBLIC_WEB_ORIGIN, useValue: 'https://arthome.test' },
    ],
  }).compile();
  ticketing = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      TicketingTransactions,
      ApplyCatalogDateFactHandler,
      OpenCapacityTierHandler,
      SetDatePricesHandler,
      { provide: DataSource, useValue: ticketingData },
      { provide: CLOCK, useValue: new FixedClock(NOW) },
    ],
  }).compile();
  await catalog.init();
  await ticketing.init();
}, STARTUP_MS);

afterAll(async () => {
  await catalog?.close();
  await ticketing?.close();
  await catalogData?.destroy();
  await ticketingData?.destroy();
  await stack?.stop();
});

describe('catalog and ticketing', () => {
  it(
    'read each other’s events, from a draft to a publication that locks the prices',
    async () => {
      const catalogCommands = catalog.get(CommandBus);
      const ticketingCommands = ticketing.get(CommandBus);
      const fromCatalog = outboxReader(catalogData);
      const fromTicketing = outboxReader(ticketingData);
      const toTicketing = async (rows: OutboxEvent[]) => {
        const outcomes: string[] = [];
        for (const row of rows) {
          outcomes.push(await applyCatalogDateMessage(ticketingCommands, routed(row)));
        }
        return outcomes;
      };
      const toCatalog = async (rows: OutboxEvent[]) => {
        const outcomes: string[] = [];
        for (const row of rows)
          outcomes.push(await applyChecklistMessage(catalogCommands, routed(row)));
        return outcomes;
      };

      await catalogCommands.execute(
        new DraftDate(
          CHANNEL,
          {
            dateId: DATE_ID,
            showId: SHOW_ID,
            venueId: VENUE_ID,
            startsAt: '2026-11-04T19:30:00.000Z',
            replayPolicy: ReplayPolicy.INCLUDED,
            replayWindowHours: 72,
          },
          null,
          idempotency(201),
        ),
      );
      expect(await toTicketing(await fromCatalog())).toEqual([Outcome.APPLIED]);

      await ticketingCommands.execute(
        new OpenCapacityTier(
          DATE_ID,
          { expectedVersion: 1, additionalCapacity: 300, notifyWaitlist: true },
          null,
          idempotency(200),
        ),
      );
      await ticketingCommands.execute(
        new SetDatePrices(
          DATE_ID,
          {
            expectedVersion: 2,
            tiers: [{ tier: PriceTier.FULL, amountMinor: 2400, currencyCode: 'EUR', active: true }],
          },
          null,
          idempotency(200),
        ),
      );
      expect(await toCatalog(await fromTicketing())).toEqual([Outcome.APPLIED, Outcome.APPLIED]);

      const at = timestampFromDate(new Date(NOW));
      for (const fact of [
        reported(
          'streaming.run.technical_check_passed.v1',
          toBinary(
            TechnicalCheckPassedSchema,
            create(TechnicalCheckPassedSchema, { dateId: DATE_ID, passedAt: at }),
          ),
        ),
        reported(
          'chat.date_chat_policy.changed.v1',
          toBinary(
            DateChatPolicyChangedSchema,
            create(DateChatPolicyChangedSchema, {
              dateId: DATE_ID,
              mode: ChatMode.OPEN,
              occurredAt: at,
            }),
          ),
        ),
      ]) {
        expect(await applyChecklistMessage(catalogCommands, fact)).toBe(Outcome.APPLIED);
      }
      const sheet = await catalog.get(QueryBus).execute(new GetDateSheet(DATE_ID));
      const satisfied = sheet.publication.checklist.filter((line) => line.satisfied);
      expect(satisfied.map(({ id }) => id)).toEqual(
        expect.arrayContaining([
          PublicationChecklistItem.CAPACITY,
          PublicationChecklistItem.AT_LEAST_ONE_ACTIVE_PRICE,
        ]),
      );

      await catalogCommands.execute(
        new TransitionPublication(
          DATE_ID,
          {
            to: PublicationState.SCHEDULED,
            expectedVersion: 1,
            acknowledgedPromiseCode: PublicationPromise.PRICES_ENGAGED,
          },
          null,
          idempotency(200),
        ),
      );
      // The state change carries nothing ticketing keeps; the start and the lock do.
      expect(await toTicketing(await fromCatalog())).toEqual([
        Outcome.IGNORED,
        Outcome.APPLIED,
        Outcome.APPLIED,
      ]);
      expect(
        await ticketingData.getRepository(DateSalesRow).findOneByOrFail({ date_id: DATE_ID }),
      ).toMatchObject({
        starts_at: new Date('2026-11-04T19:30:00.000Z'),
        prices_locked_at: expect.any(Date) as unknown,
        on_sale: true,
      });
      expect(await toCatalog(await fromTicketing())).toEqual([Outcome.APPLIED]);

      await expect(
        ticketingCommands.execute(
          new SetDatePrices(DATE_ID, { expectedVersion: 5, tiers: [] }, null, idempotency(200)),
        ),
      ).rejects.toMatchObject({ refusal: { code: CatalogErrorCode.PRICES_LOCKED } });
    },
    CASE_MS,
  );
});
