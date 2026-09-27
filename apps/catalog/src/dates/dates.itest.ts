import {
  ChatMode,
  DateChatPolicyChangedSchema,
  DateDraftedSchema,
  DateOutcomeDeclaredSchema,
  DateRescheduledSchema,
  DateSalesCapacitySetSchema,
  DateScheduledSchema,
  PublicationEngagedSchema,
  PublicationEngagement,
  DateSalesPricingChangedSchema,
  PriceTier,
  PublicationState as WirePublicationState,
  PublicationStateChangedSchema,
  ShowUpdatedSchema,
  TechnicalCheckPassedSchema,
} from '@arthome-platform/events';
import { RefusalException, type IdempotentRequest } from '@arthome-platform/http-edge';
import {
  ATTEMPT_HEADER,
  DLQ_REASON_HEADER,
  ERROR_HEADER,
  OutboxEvent,
  PermanentError,
  ProcessedMessage,
  deadLetterTopic,
  dispatch,
} from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageInitShape,
} from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { CommandBus, CqrsModule, EventBus, QueryBus, type IEvent } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import type { EachMessagePayload, Producer, ProducerRecord } from 'kafkajs';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ApiErrorCode,
  CatalogErrorCode,
  DateOutcome,
  DisplayState,
  DomainConstant,
  DomainErrorCode,
  FixedClock,
  LanguageDependency,
  Locale,
  PublicationChecklistItem,
  PublicationPromise,
  PublicationState,
  ReplayPolicy,
  Service,
} from '@arthome/core';

import { applyChecklistMessage } from './checklist-consumer.js';
import { DeclareOutcome } from './declare-outcome.command.js';
import { DeclareOutcomeHandler } from './declare-outcome.handler.js';
import { DraftDate } from './draft-date.command.js';
import { DraftDateHandler } from './draft-date.handler.js';
import { GetDateSheetHandler } from './get-date-sheet.handler.js';
import { GetDateSheet } from './get-date-sheet.query.js';
import { PerformanceDateRow } from './performance-date.entity.js';
import { DateOutcomeDeclared, DateRescheduled } from './performance-date.events.js';
import { PublicationChecklistFact } from './publication-checklist-fact.entity.js';
import { PublicationRow } from './publication.entity.js';
import { RecordChecklistFactHandler } from './record-checklist-fact.handler.js';
import { TransitionPublication } from './transition-publication.command.js';
import { TransitionPublicationHandler } from './transition-publication.handler.js';
import type { TransitionPublicationBody } from './transition-publication.schema.js';
import { UpdateChannelIdentity } from '../artists/update-channel-identity.command.js';
import { UpdateChannelIdentityHandler } from '../artists/update-channel-identity.handler.js';
import { Show } from '../catalog/show.entity.js';
import { UpdateShow } from '../catalog/update-show.command.js';
import { UpdateShowHandler } from '../catalog/update-show.handler.js';
import { CatalogTransactions } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { publicQueryBus } from '../itest/public-query-bus.js';
import { CATALOG_SCHEMA } from '../itest/schema.js';
import { DateDetailPublic } from '../public/date-detail-public.entity.js';
import { GetArtistDetail } from '../public/get-artist-detail.query.js';
import { GetDateDetail } from '../public/get-date-detail.query.js';
import { ResolvePublicLink } from '../public/resolve-public-link.query.js';
import { LinkKind } from '../public/resolve-query.schema.js';
import { SlugAlias } from '../public/slug-alias.entity.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { Venue } from '../venues/venue.entity.js';

/**
 * The date commands against a real Postgres, reading back what each one leaves in the outbox:
 * every row must name the date's topic and carry `date_id` as its key (events.md §3.1).
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const CHANNEL = 'channel-itest';
const SHOW_ID = '01a0e100-0000-7000-8000-000000000001';
const VENUE_ID = '01a0e100-0000-7000-8000-000000000002';

let stack: StartedStack;
let dataSource: DataSource;
let cqrs: TestingModule;
let commands: CommandBus;
let queries: QueryBus;
let keys = 0;

function idempotency(fingerprint: string): IdempotentRequest {
  keys += 1;
  return {
    key: `01a0e1ff-0000-7000-8000-${String(keys).padStart(12, '0')}`,
    accountId: null,
    fingerprint,
    statusCode: 201,
  };
}

async function draft(dateId: string, key: IdempotentRequest = idempotency(dateId)) {
  return commands.execute(
    new DraftDate(
      CHANNEL,
      {
        dateId,
        showId: SHOW_ID,
        venueId: VENUE_ID,
        startsAt: '2026-11-04T19:30:00.000Z',
        replayPolicy: ReplayPolicy.INCLUDED,
        replayWindowHours: 72,
      },
      null,
      key,
    ),
  );
}

function move(
  dateId: string,
  to: TransitionPublicationBody['to'],
  expectedVersion: number,
  acknowledgedPromiseCode: PublicationPromise | null = null,
) {
  return commands.execute(
    new TransitionPublication(
      dateId,
      { to, expectedVersion, acknowledgedPromiseCode },
      null,
      idempotency(`${dateId}:${to}:${expectedVersion}`),
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

function sheet(dateId: string) {
  return queries.execute(new GetDateSheet(dateId));
}

function outboxRowsFor(dateId: string): Promise<OutboxEvent[]> {
  return dataSource.getRepository(OutboxEvent).find({
    where: { aggregateid: dateId },
    order: { created_at: 'ASC', id: 'ASC' },
  });
}

let messages = 0;

function upstream<Desc extends DescMessage>(
  type: string,
  schema: Desc,
  init: MessageInitShape<Desc>,
  messageId = `01a0e2ff-0000-7000-8000-${String((messages += 1)).padStart(12, '0')}`,
): EachMessagePayload {
  return {
    topic: 'arthome.ticketing.date_sales',
    partition: 0,
    message: {
      key: Buffer.from('date'),
      value: Buffer.from(toBinary(schema, create(schema, init))),
      headers: { 'message-id': Buffer.from(messageId), type: Buffer.from(type) },
    },
  } as unknown as EachMessagePayload;
}

const AT = timestampFromDate(new Date('2026-09-26T09:00:00.000Z'));

/** The four projected blocking items, reported the way their contexts will report them. */
async function satisfyProjectedItems(dateId: string): Promise<void> {
  for (const payload of [
    upstream('ticketing.date_sales.pricing_changed.v1', DateSalesPricingChangedSchema, {
      dateId,
      tiers: [{ tier: PriceTier.FULL, active: true }],
      occurredAt: AT,
    }),
    upstream('ticketing.date_sales.capacity_set.v1', DateSalesCapacitySetSchema, {
      dateId,
      capacityTotal: 300,
      occurredAt: AT,
    }),
    upstream('streaming.run.technical_check_passed.v1', TechnicalCheckPassedSchema, {
      dateId,
      passedAt: AT,
    }),
    upstream('chat.date_chat_policy.changed.v1', DateChatPolicyChangedSchema, {
      dateId,
      mode: ChatMode.OPEN,
      occurredAt: AT,
    }),
  ]) {
    expect(await applyChecklistMessage(commands, payload)).toBe('applied');
  }
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'catalog_dates_itest');
  dataSource = await applyMigrations(database, CATALOG_SCHEMA);
  await dataSource.getRepository(Show).insert({
    id: SHOW_ID,
    slug: 'nuit-blanche',
    channel_id: CHANNEL,
    artist_id: 'artist-itest',
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
    title: { fr: 'Nuit blanche', en: '' },
    synopsis: { fr: 'Une nuit.', en: '' },
  });
  await dataSource.getRepository(Venue).insert({
    id: VENUE_ID,
    name: 'Théâtre de la Ville',
    city: 'Paris',
    country: 'FR',
    time_zone: 'Europe/Paris',
  });
  cqrs = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      CatalogTransactions,
      DeclareOutcomeHandler,
      DraftDateHandler,
      GetDateSheetHandler,
      RecordChecklistFactHandler,
      TransitionPublicationHandler,
      UpdateShowHandler,
      UpdateChannelIdentityHandler,
      { provide: DataSource, useValue: dataSource },
      { provide: CLOCK, useValue: new FixedClock('2026-09-26T10:00:00.000Z') },
      { provide: PUBLIC_WEB_ORIGIN, useValue: 'https://arthome.test' },
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

describe('a date draft', () => {
  it(
    'writes the date, its draft publication and one DateDrafted on the date’s topic',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-000000000101';
      const response = await draft(dateId);

      expect(response.envelope.data.publication).toMatchObject({
        state: PublicationState.DRAFT,
        version: 1,
      });
      expect(response.envelope.data.venueClock.utcOffsetMinutes).toBe(60);
      // No slug before publication, so no URL: found on the running stack as `/fr/d/undefined`.
      expect(response.envelope.data.canonicalUrl).toBeNull();

      const rows = await outboxRowsFor(dateId);
      expect(rows.map((row) => [row.aggregatetype, row.type])).toEqual([
        ['catalog.date', 'catalog.date.drafted.v1'],
      ]);
      const event = fromBinary(DateDraftedSchema, rows[0]?.payload ?? new Uint8Array());
      expect(event).toMatchObject({
        dateId,
        channelId: CHANNEL,
        showId: SHOW_ID,
        venueId: VENUE_ID,
      });
    },
    CASE_MS,
  );

  it(
    'is replayed under the same key, with no second date and no second event',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-000000000102';
      const key = idempotency(dateId);
      const first = await draft(dateId, key);
      const again = await draft(dateId, key);

      expect(again.replayed).toBe(true);
      expect(JSON.stringify(again.envelope)).toBe(JSON.stringify(first.envelope));
      expect(await outboxRowsFor(dateId)).toHaveLength(1);
    },
    CASE_MS,
  );

  it(
    'refuses another channel’s show, naming the field',
    async () => {
      const refusal = await refusalOf(
        commands.execute(
          new DraftDate(
            'someone-else',
            {
              dateId: '01a0e100-0000-7000-8000-000000000103',
              showId: SHOW_ID,
              venueId: VENUE_ID,
              startsAt: '2026-11-04T19:30:00.000Z',
              replayPolicy: ReplayPolicy.NONE,
              replayWindowHours: null,
            },
            null,
            idempotency('other-channel'),
          ),
        ),
      );
      expect(refusal.refusal).toMatchObject({
        code: ApiErrorCode.SCHEMA_INVALID,
        params: { fields: ['showId'] },
      });
    },
    CASE_MS,
  );
});

describe('a publication transition', () => {
  it(
    'moves the state, bumps the version and emits PublicationStateChanged keyed by the date',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-000000000201';
      await draft(dateId);

      const moved = await move(dateId, PublicationState.RESERVE, 1);
      expect(moved.envelope.data).toMatchObject({ state: PublicationState.RESERVE, version: 2 });

      const rows = await outboxRowsFor(dateId);
      expect(rows.map((row) => [row.aggregatetype, row.aggregateid, row.type])).toEqual([
        ['catalog.date', dateId, 'catalog.date.drafted.v1'],
        ['catalog.date', dateId, 'catalog.publication.state_changed.v1'],
      ]);
      const event = fromBinary(PublicationStateChangedSchema, rows[1]?.payload ?? new Uint8Array());
      expect(event).toMatchObject({
        dateId,
        fromState: WirePublicationState.DRAFT,
        toState: WirePublicationState.RESERVE,
        version: 2n,
        irreversible: false,
      });
    },
    CASE_MS,
  );

  it(
    'refuses a stale version with the current state and version',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-000000000202';
      await draft(dateId);
      await move(dateId, PublicationState.RESERVE, 1);

      const refusal = await refusalOf(move(dateId, PublicationState.DRAFT, 1));
      expect(refusal.getStatus()).toBe(409);
      expect(refusal.refusal).toMatchObject({
        code: DomainErrorCode.STATE_CONFLICT,
        params: { state: PublicationState.RESERVE, version: 2 },
      });
    },
    CASE_MS,
  );

  it(
    'refuses to publish without the promise acknowledged, then with the checklist incomplete',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-000000000203';
      await draft(dateId);

      const unacknowledged = await refusalOf(move(dateId, PublicationState.SCHEDULED, 1));
      expect(unacknowledged.refusal).toMatchObject({
        code: DomainErrorCode.PUBLICATION_PROMISE_UNACKNOWLEDGED,
        params: { promise: PublicationPromise.PRICES_ENGAGED },
      });

      const incomplete = await refusalOf(
        move(dateId, PublicationState.SCHEDULED, 1, PublicationPromise.PRICES_ENGAGED),
      );
      expect(incomplete.getStatus()).toBe(409);
      expect(incomplete.refusal).toMatchObject({
        code: DomainErrorCode.PUBLICATION_CHECKLIST_INCOMPLETE,
        params: {
          missing: [
            PublicationChecklistItem.AT_LEAST_ONE_ACTIVE_PRICE,
            PublicationChecklistItem.CAPACITY,
            PublicationChecklistItem.TECHNICAL_CHECK_PASSED,
            PublicationChecklistItem.CHAT_MODE_SET,
          ],
        },
      });
      expect(await outboxRowsFor(dateId)).toHaveLength(1);
    },
    CASE_MS,
  );

  it(
    'publishes once the checklist is complete, and then refuses the way back',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-000000000204';
      await draft(dateId);
      await satisfyProjectedItems(dateId);

      const published = await move(
        dateId,
        PublicationState.SCHEDULED,
        1,
        PublicationPromise.PRICES_ENGAGED,
      );
      expect(published.envelope.data).toMatchObject({
        state: PublicationState.SCHEDULED,
        version: 2,
        publishedAt: '2026-09-26T10:00:00.000Z',
        pricesLockedAt: '2026-09-26T10:00:00.000Z',
      });
      const rows = await outboxRowsFor(dateId);
      expect(rows.map((row) => [row.aggregatetype, row.aggregateid, row.type])).toEqual([
        ['catalog.date', dateId, 'catalog.date.drafted.v1'],
        ['catalog.date', dateId, 'catalog.publication.state_changed.v1'],
        ['catalog.date', dateId, 'catalog.date.scheduled.v1'],
        ['catalog.date', dateId, 'catalog.publication.engaged.v1'],
      ]);
      const changed = fromBinary(
        PublicationStateChangedSchema,
        rows[1]?.payload ?? new Uint8Array(),
      );
      expect(changed.irreversible).toBe(true);

      const scheduled = fromBinary(DateScheduledSchema, rows[2]?.payload ?? new Uint8Array());
      expect(scheduled).toMatchObject({
        dateId,
        runtimeMin: 95,
        replayWindowHours: 72,
        canonicalUrl: 'https://arthome.test/show/nuit-blanche/date/2026-11-04',
        showSlug: 'nuit-blanche',
        slug: '2026-11-04',
        venueCity: 'Paris',
        venueCountry: 'FR',
        venueClock: { venueTimezone: 'Europe/Paris', venueUtcOffsetMin: 60 },
      });
      const engaged = fromBinary(PublicationEngagedSchema, rows[3]?.payload ?? new Uint8Array());
      expect(engaged.engaged).toEqual([
        PublicationEngagement.PRICES,
        PublicationEngagement.REPLAY,
        PublicationEngagement.CHAT_MODE,
      ]);
      expect((await sheet(dateId)).canonicalUrl).toBe(scheduled.canonicalUrl);

      const back = await refusalOf(move(dateId, PublicationState.DRAFT, 2));
      expect(back.refusal).toMatchObject({
        code: DomainErrorCode.PUBLICATION_TRANSITION_IRREVERSIBLE,
        params: { promise: PublicationPromise.PRICES_ENGAGED },
      });
    },
    CASE_MS,
  );
});

describe('a date already published', () => {
  it(
    'goes back from technical to scheduled without publishing again or rereading the checklist',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-000000000205';
      await draft(dateId);
      await satisfyProjectedItems(dateId);
      await move(dateId, PublicationState.SCHEDULED, 1, PublicationPromise.PRICES_ENGAGED);
      await move(dateId, PublicationState.TECHNICAL, 2);
      await applyChecklistMessage(
        commands,
        upstream('ticketing.date_sales.pricing_changed.v1', DateSalesPricingChangedSchema, {
          dateId,
          tiers: [{ tier: PriceTier.FULL, active: false }],
          occurredAt: timestampFromDate(new Date('2026-09-26T11:00:00.000Z')),
        }),
      );

      const back = await move(dateId, PublicationState.SCHEDULED, 3);
      expect(back.envelope.data).toMatchObject({ state: PublicationState.SCHEDULED, version: 4 });
      const scheduledEvents = (await outboxRowsFor(dateId)).filter(
        (row) => row.type === 'catalog.date.scheduled.v1',
      );
      expect(scheduledEvents).toHaveLength(1);
    },
    CASE_MS,
  );

  it(
    'takes a second slug when another date of the same show is published the same day',
    async () => {
      const first = '01a0e100-0000-7000-8000-000000000206';
      const second = '01a0e100-0000-7000-8000-000000000207';
      for (const dateId of [first, second]) {
        await draft(dateId);
        await satisfyProjectedItems(dateId);
      }
      await move(first, PublicationState.SCHEDULED, 1, PublicationPromise.PRICES_ENGAGED);
      await move(second, PublicationState.SCHEDULED, 1, PublicationPromise.PRICES_ENGAGED);

      const urls = [(await sheet(first)).canonicalUrl, (await sheet(second)).canonicalUrl];
      // Earlier cases published this show on the same day, so which candidate each takes depends
      // on order; that they never share one does not.
      expect(new Set(urls).size).toBe(2);
      for (const url of urls) {
        expect(url).toMatch(/\/show\/nuit-blanche\/date\/2026-11-04(-\d{4}|-[0-9a-f]{8})?$/);
      }
    },
    CASE_MS,
  );
});

describe('a projected checklist fact', () => {
  function pricing(dateId: string, active: boolean, at: string, messageId?: string) {
    return upstream(
      'ticketing.date_sales.pricing_changed.v1',
      DateSalesPricingChangedSchema,
      {
        dateId,
        tiers: [{ tier: PriceTier.FULL, active }],
        occurredAt: timestampFromDate(new Date(at)),
      },
      messageId,
    );
  }

  async function activePrice(dateId: string): Promise<boolean | undefined> {
    const fact = await dataSource.getRepository(PublicationChecklistFact).findOneBy({
      date_id: dateId,
      item: PublicationChecklistItem.AT_LEAST_ONE_ACTIVE_PRICE,
    });
    return fact?.satisfied;
  }

  it(
    'keeps the newer fact when an older one arrives after it, off a retry topic',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-000000000301';
      await draft(dateId);

      await applyChecklistMessage(commands, pricing(dateId, true, '2026-09-26T10:00:00.000Z'));
      const late = await applyChecklistMessage(
        commands,
        pricing(dateId, false, '2026-09-26T09:00:00.000Z'),
      );

      expect(late).toBe('superseded');
      expect(await activePrice(dateId)).toBe(true);
    },
    CASE_MS,
  );

  it(
    'applies a message once, however many times it is delivered',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-000000000302';
      await draft(dateId);
      const once = pricing(
        dateId,
        true,
        '2026-09-26T10:00:00.000Z',
        '01a0e2aa-0000-7000-8000-000000000001',
      );

      expect(await applyChecklistMessage(commands, once)).toBe('applied');
      expect(await applyChecklistMessage(commands, once)).toBe('duplicate');
    },
    CASE_MS,
  );

  it(
    'dead-letters a fact about a date catalog does not hold, and keeps no ledger row for it',
    async () => {
      const messageId = '01a0e2aa-0000-7000-8000-000000000002';
      await expect(
        applyChecklistMessage(
          commands,
          pricing(
            '01a0e100-0000-7000-8000-0000000003ff',
            true,
            '2026-09-26T10:00:00.000Z',
            messageId,
          ),
        ),
      ).rejects.toThrow(PermanentError);
      expect(
        await dataSource.getRepository(ProcessedMessage).findOneBy({ id: messageId }),
      ).toBeNull();
    },
    CASE_MS,
  );

  it(
    'parks that refusal from the bus as the consumer always has: dead-lettered at once, attempt 0',
    async () => {
      const messageId = '01a0e2aa-0000-7000-8000-000000000003';
      const dateId = '01a0e100-0000-7000-8000-0000000003fe';
      const parked: ProducerRecord[] = [];
      const producer = {
        send: (record: ProducerRecord) => {
          parked.push(record);
          return Promise.resolve([]);
        },
      } as unknown as Producer;

      const disposition = await dispatch(
        (payload) => applyChecklistMessage(commands, payload),
        producer,
        Service.CATALOG,
        pricing(dateId, true, '2026-09-26T10:00:00.000Z', messageId),
      );

      expect(disposition).toBe('dead-lettered');
      expect(parked.map((record) => record.topic)).toEqual([deadLetterTopic(Service.CATALOG)]);
      expect(parked[0]?.messages[0]?.headers).toMatchObject({
        [ATTEMPT_HEADER]: '0',
        [DLQ_REASON_HEADER]: 'permanent',
        [ERROR_HEADER]: `PermanentError: message ${messageId} is about date ${dateId}, unknown here`,
      });
    },
    CASE_MS,
  );
});

describe('a show update', () => {
  function showEvents(): Promise<OutboxEvent[]> {
    return dataSource.getRepository(OutboxEvent).find({
      where: { aggregateid: SHOW_ID, type: 'catalog.show.updated.v1' },
      order: { created_at: 'ASC', id: 'ASC' },
    });
  }

  it(
    'emits ShowUpdated on the show’s topic, carrying every indexed field at its new value',
    async () => {
      await commands.execute(new UpdateShow(SHOW_ID, { genreIds: ['comedy'] }, null));

      const rows = await showEvents();
      expect(rows.map((row) => row.aggregatetype)).toEqual(['catalog.show']);
      const event = fromBinary(ShowUpdatedSchema, rows[0]?.payload ?? new Uint8Array());
      expect(event.genreIds).toEqual(['comedy']);
      expect(event.media?.poster).toHaveLength(1);
    },
    CASE_MS,
  );

  it(
    'publishes a copy change too, now that the event carries the copy',
    async () => {
      const before = (await showEvents()).length;
      await commands.execute(
        new UpdateShow(SHOW_ID, { synopsis: { fr: 'Une autre nuit.', en: '' } }, null),
      );
      const rows = await showEvents();
      expect(rows).toHaveLength(before + 1);
      const event = fromBinary(ShowUpdatedSchema, rows.at(-1)?.payload ?? new Uint8Array());
      expect(event.synopsis).toMatchObject([
        { contentLanguage: Locale.FR, text: 'Une autre nuit.' },
      ]);
      expect(event.title).toMatchObject([{ contentLanguage: Locale.FR, text: 'Nuit blanche' }]);
    },
    CASE_MS,
  );

  it(
    'answers 404 for a show catalog does not hold',
    async () => {
      const refusal = await refusalOf(
        commands.execute(
          new UpdateShow('01a0e100-0000-7000-8000-0000000009ff', { tagIds: [] }, null),
        ),
      );
      expect(refusal.getStatus()).toBe(404);
    },
    CASE_MS,
  );
});

describe('the public date page', () => {
  const ORIGIN = 'https://arthome.test';
  const publicQueries = () =>
    publicQueryBus(dataSource, new FixedClock('2026-09-26T10:00:00.000Z'), ORIGIN);
  const rowOf = (dateId: string) =>
    dataSource.getRepository(DateDetailPublic).findOneBy({ date_id: dateId });

  it(
    'enters the read model when published, and follows each transition after that',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-0000000004a1';
      await draft(dateId);
      await satisfyProjectedItems(dateId);
      expect(await rowOf(dateId)).toBeNull();

      await move(dateId, PublicationState.SCHEDULED, 1, PublicationPromise.PRICES_ENGAGED);
      expect(await rowOf(dateId)).toMatchObject({
        publication_state: PublicationState.SCHEDULED,
        venue_name: 'Théâtre de la Ville',
        show_slug: 'nuit-blanche',
        slug: expect.stringMatching(/^2026-11-04/) as unknown,
        version: '1',
      });

      await move(dateId, PublicationState.TECHNICAL, 2);
      expect(await rowOf(dateId)).toMatchObject({
        publication_state: PublicationState.TECHNICAL,
        version: '2',
      });
    },
    CASE_MS,
  );

  it(
    'serves the page with the show’s copy and its other public dates, and 404 for a draft',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-0000000004a1';
      const { data } = await publicQueries().execute(new GetDateDetail(dateId));

      expect(data).toMatchObject({
        id: dateId,
        title: 'Nuit blanche',
        displayState: DisplayState.SCHEDULED,
        synopsis: { contentLanguage: Locale.FR, text: 'Une autre nuit.' },
        spokenLanguages: ['fr-FR'],
        venue: { name: 'Théâtre de la Ville', city: 'Paris' },
      });
      const others = await dataSource.getRepository(DateDetailPublic).countBy({ show_id: SHOW_ID });
      expect(data.totalSeriesDates).toBe(others - 1);
      // `DateDetailSchema`'s declared type widens the page's own fields: read them as the wire has them.
      const series = data.seriesDates as readonly { readonly id: string }[];
      expect(series.map((card) => card.id)).not.toContain(dateId);

      const draftOnly = '01a0e100-0000-7000-8000-0000000004a2';
      await draft(draftOnly);
      expect(
        (await refusalOf(publicQueries().execute(new GetDateDetail(draftOnly)))).getStatus(),
      ).toBe(404);
    },
    CASE_MS,
  );

  it(
    'carries a show update onto every public date of the show',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-0000000004a1';
      const before = await rowOf(dateId);
      await commands.execute(new UpdateShow(SHOW_ID, { tagIds: ['late-night'] }, null));

      const after = await rowOf(dateId);
      expect(after?.tag_ids).toEqual(['late-night']);
      expect(Number(after?.version)).toBe(Number(before?.version) + 1);
    },
    CASE_MS,
  );

  it(
    'resolves a canonical URL or a slug to the date or its show, and nothing else',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-0000000004a1';
      const url = (await sheet(dateId)).canonicalUrl ?? '';
      const slug = `nuit-blanche/${url.split('/').at(-1) ?? ''}`;

      const byUrl = await publicQueries().execute(new ResolvePublicLink({ url }));
      const bySlug = await publicQueries().execute(
        new ResolvePublicLink({ kind: LinkKind.DATE, slug }),
      );
      expect(byUrl.data).toMatchObject({ kind: LinkKind.DATE, id: dateId, canonicalUrl: url });
      expect(bySlug.data.id).toBe(dateId);
      for (const show of [`${ORIGIN}/show/nuit-blanche`, `${ORIGIN}/s/nuit-blanche`]) {
        expect((await publicQueries().execute(new ResolvePublicLink({ url: show }))).data).toEqual({
          kind: LinkKind.SHOW,
          id: SHOW_ID,
          canonicalUrl: `${ORIGIN}/show/nuit-blanche`,
        });
      }

      for (const dead of [
        { url: url.replace(ORIGIN, 'https://elsewhere.test') },
        { url: `${url}-x` },
        { url: url.replace('nuit-blanche', 'nuit-noire') },
        { kind: LinkKind.DATE, slug: url.split('/').at(-1) ?? '' },
      ]) {
        expect(
          (await refusalOf(publicQueries().execute(new ResolvePublicLink(dead)))).getStatus(),
        ).toBe(404);
      }
      const both = await refusalOf(
        publicQueries().execute(new ResolvePublicLink({ url, kind: LinkKind.DATE, slug })),
      );
      expect(both.refusal).toMatchObject({
        code: ApiErrorCode.SCHEMA_INVALID,
        params: { fields: ['kind', 'slug'] },
      });
    },
    CASE_MS,
  );

  it(
    'is rebuilt by its migration, and every published date states its facts again with its URL',
    async () => {
      const rows = await dataSource
        .getRepository(DateDetailPublic)
        .find({ order: { date_id: 'ASC' } });
      const scheduledBefore = (await outboxRowsFor('01a0e100-0000-7000-8000-0000000004a1')).filter(
        (row) => row.type === 'catalog.date.scheduled.v1',
      );
      await dataSource.undoLastMigration();
      await dataSource.runMigrations();
      const rebuilt = await dataSource
        .getRepository(DateDetailPublic)
        .find({ order: { date_id: 'ASC' } });

      expect(
        rebuilt.map(({ date_id, publication_state, tag_ids }) => [
          date_id,
          publication_state,
          tag_ids,
        ]),
      ).toEqual(
        rows.map(({ date_id, publication_state, tag_ids }) => [
          date_id,
          publication_state,
          tag_ids,
        ]),
      );

      const scheduledAfter = (await outboxRowsFor('01a0e100-0000-7000-8000-0000000004a1')).filter(
        (row) => row.type === 'catalog.date.scheduled.v1',
      );
      expect(scheduledAfter).toHaveLength(scheduledBefore.length + 1);
      const restated = fromBinary(
        DateScheduledSchema,
        scheduledAfter.at(-1)?.payload ?? new Uint8Array(),
      );
      const row = rebuilt.find((candidate) => candidate.date_id === restated.dateId);
      expect(restated).toMatchObject({ showSlug: 'nuit-blanche', slug: row?.slug });
      expect(restated.canonicalUrl).toMatch(new RegExp(`/show/nuit-blanche/date/${row?.slug}$`));
    },
    CASE_MS,
  );
});

describe('a date outcome', () => {
  const ORIGIN = 'https://arthome.test';
  const MESSAGE = {
    contentLanguage: Locale.FR,
    text: 'Report au 12 novembre. Vos places restent valables.',
  };
  const publicQueries = (at = '2026-09-26T10:00:00.000Z') =>
    publicQueryBus(dataSource, new FixedClock(at), ORIGIN);

  async function published(dateId: string): Promise<void> {
    await draft(dateId);
    await satisfyProjectedItems(dateId);
    await move(dateId, PublicationState.SCHEDULED, 1, PublicationPromise.PRICES_ENGAGED);
  }

  function declare(
    dateId: string,
    outcome: DateOutcome,
    expectedVersion: number,
    rescheduledTo: string | null = null,
  ) {
    return commands.execute(
      new DeclareOutcome(
        dateId,
        { outcome, message: MESSAGE, rescheduledTo, expectedVersion },
        null,
        idempotency(`${dateId}:${outcome}:${expectedVersion}`),
      ),
    );
  }

  it(
    'postpones a date by moving it, then says so on its page until its new room opens',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-0000000005a1';
      await published(dateId);
      const before = (await sheet(dateId)).canonicalUrl;

      const response = await declare(dateId, DateOutcome.POSTPONED, 2, '2026-11-12T19:30:00.000Z');
      expect(response.envelope.data).toEqual({
        outcome: DateOutcome.POSTPONED,
        declaredAt: '2026-09-26T10:00:00.000Z',
      });

      const date = await dataSource
        .getRepository(PerformanceDateRow)
        .findOneByOrFail({ id: dateId });
      expect(date).toMatchObject({
        outcome: DateOutcome.POSTPONED,
        outcome_message: MESSAGE,
        slug: '2026-11-12',
        postponements: 1,
      });
      expect(date.starts_at.toISOString()).toBe('2026-11-12T19:30:00.000Z');
      const publication = await dataSource
        .getRepository(PublicationRow)
        .findOneByOrFail({ date_id: dateId });
      expect(publication.version).toBe(3);

      const rows = (await outboxRowsFor(dateId)).slice(-2);
      expect(rows.map((row) => [row.aggregatetype, row.type])).toEqual([
        ['catalog.date', 'catalog.date.outcome_declared.v1'],
        ['catalog.date', 'catalog.date.rescheduled.v1'],
      ]);
      const declared = fromBinary(DateOutcomeDeclaredSchema, rows[0]?.payload ?? new Uint8Array());
      expect(declared.message).toMatchObject(MESSAGE);
      const rescheduled = fromBinary(DateRescheduledSchema, rows[1]?.payload ?? new Uint8Array());
      expect(rescheduled.previousStartsAt?.seconds).toBe(
        BigInt(Date.parse('2026-11-04T19:30:00.000Z') / 1000),
      );
      expect(rescheduled).toMatchObject({
        newVenueClock: { venueTimezone: 'Europe/Paris', venueUtcOffsetMin: 60 },
        newSlug: '2026-11-12',
        newCanonicalUrl: `${ORIGIN}/show/nuit-blanche/date/2026-11-12`,
      });

      const page = await publicQueries().execute(new GetDateDetail(dateId));
      expect(page.data).toMatchObject({
        displayState: DisplayState.POSTPONED,
        displayStateValidUntil: '2026-11-12T19:00:00.000Z',
        outcome: DateOutcome.POSTPONED,
        rescheduledTo: '2026-11-12T19:30:00.000Z',
        startsAt: '2026-11-12T19:30:00.000Z',
        slug: '2026-11-12',
        canonicalUrl: `${ORIGIN}/show/nuit-blanche/date/2026-11-12`,
      });
      // D-075: the URL shared before the move still leads to the date, under its new form.
      expect(
        (await publicQueries().execute(new ResolvePublicLink({ url: before ?? '' }))).data,
      ).toMatchObject({
        kind: LinkKind.DATE,
        id: dateId,
        canonicalUrl: `${ORIGIN}/show/nuit-blanche/date/2026-11-12`,
      });
    },
    CASE_MS,
  );

  it(
    'refuses a stale screen, postpones up to three times, then only cancels (D-076)',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-0000000005a1';

      const stale = await refusalOf(declare(dateId, DateOutcome.CANCELLED, 2));
      expect(stale.refusal).toMatchObject({
        code: DomainErrorCode.STATE_CONFLICT,
        params: { state: PublicationState.SCHEDULED, version: 3 },
      });
      await declare(dateId, DateOutcome.POSTPONED, 3, '2026-11-19T19:30:00.000Z');
      await declare(dateId, DateOutcome.POSTPONED, 4, '2026-11-26T19:30:00.000Z');

      const fourth = await refusalOf(
        declare(dateId, DateOutcome.POSTPONED, 5, '2026-12-03T19:30:00.000Z'),
      );
      expect(fourth.getStatus()).toBe(409);
      expect(fourth.refusal).toMatchObject({
        code: CatalogErrorCode.POSTPONEMENT_LIMIT_REACHED,
        params: { max: DomainConstant.POSTPONEMENTS_MAX },
      });

      await declare(dateId, DateOutcome.CANCELLED, 5);
      const date = await dataSource
        .getRepository(PerformanceDateRow)
        .findOneByOrFail({ id: dateId });
      expect(date).toMatchObject({
        outcome: DateOutcome.CANCELLED,
        rescheduled_to: null,
        slug: '2026-11-26',
        postponements: 3,
      });
      expect(date.starts_at.toISOString()).toBe('2026-11-26T19:30:00.000Z');

      const final = await refusalOf(
        declare(dateId, DateOutcome.POSTPONED, 6, '2026-12-03T19:30:00.000Z'),
      );
      expect(final.refusal.params).toEqual({ outcome: DateOutcome.CANCELLED });
    },
    CASE_MS,
  );

  it(
    'lets every slug a move replaced lead to the date for a month, and no longer',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-0000000005a1';
      const aliases = await dataSource
        .getRepository(SlugAlias)
        .findBy({ kind: LinkKind.DATE, target_id: dateId });
      expect(aliases.map((alias) => alias.slug).sort()).toEqual([
        expect.stringMatching(/^2026-11-04/) as unknown,
        '2026-11-12',
        '2026-11-19',
      ]);

      const retired = `${ORIGIN}/show/nuit-blanche/date/2026-11-12`;
      expect(
        (await publicQueries().execute(new ResolvePublicLink({ url: retired }))).data,
      ).toMatchObject({
        id: dateId,
        canonicalUrl: `${ORIGIN}/show/nuit-blanche/date/2026-11-26`,
      });
      const monthLater = new Date(
        Date.parse('2026-09-26T10:00:00.000Z') + DomainConstant.SLUG_REDIRECT_DAYS * 86_400_000,
      ).toISOString();
      expect(
        (
          await refusalOf(
            publicQueries(monthLater).execute(new ResolvePublicLink({ url: retired })),
          )
        ).getStatus(),
      ).toBe(404);
    },
    CASE_MS,
  );

  it(
    'cancels a date for good, and refuses to interrupt one that has not started',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-0000000005a2';
      await published(dateId);

      const early = await refusalOf(declare(dateId, DateOutcome.INTERRUPTED, 2));
      expect(early.refusal).toMatchObject({
        code: DomainErrorCode.STATE_CONFLICT,
        params: { startsAt: '2026-11-04T19:30:00.000Z' },
      });

      await declare(dateId, DateOutcome.CANCELLED, 2);
      const types = (await outboxRowsFor(dateId)).map((row) => row.type);
      expect(types.at(-1)).toBe('catalog.date.outcome_declared.v1');
      expect(types).not.toContain('catalog.date.rescheduled.v1');
      expect((await publicQueries().execute(new GetDateDetail(dateId))).data).toMatchObject({
        displayState: DisplayState.CANCELLED,
        displayStateValidUntil: null,
        outcome: DateOutcome.CANCELLED,
      });
    },
    CASE_MS,
  );

  it(
    'publishes the date’s domain events once committed, and none for a replay or a refusal',
    async () => {
      const dateId = '01a0e100-0000-7000-8000-0000000005a3';
      await published(dateId);
      const outcomeCommitted = () =>
        dataSource
          .getRepository(PerformanceDateRow)
          .findOneByOrFail({ id: dateId })
          .then((row) => row.outcome);
      const delivered: IEvent[] = [];
      // Read on another connection the moment each event arrives: only a committed write shows.
      const committedWhenDelivered: Promise<DateOutcome | null>[] = [];
      const subscription = cqrs.get(EventBus).subscribe((event) => {
        delivered.push(event);
        committedWhenDelivered.push(outcomeCommitted());
      });
      // Every COMMIT first waits for the reads already started, so an event delivered inside the
      // transaction is read before its write commits, whatever the timing.
      const createQueryRunner = dataSource.createQueryRunner.bind(dataSource);
      const readsFirst = vi.spyOn(dataSource, 'createQueryRunner').mockImplementation((mode) => {
        const runner = createQueryRunner(mode);
        const commit = runner.commitTransaction.bind(runner);
        runner.commitTransaction = async () => {
          await Promise.all(committedWhenDelivered);
          await commit();
        };
        return runner;
      });
      // A failure after the save: the outbox refuses this date's rows, so the transaction rolls
      // back with the date and its publication already written.
      const refuseOutbox = async (refused: boolean): Promise<void> => {
        await dataSource.query(
          refused
            ? `CREATE TRIGGER refuse_outbox_itest BEFORE INSERT ON outbox_event FOR EACH ROW
                 WHEN (NEW.aggregateid = '${dateId}') EXECUTE FUNCTION refuse_outbox_itest()`
            : 'DROP TRIGGER refuse_outbox_itest ON outbox_event',
        );
      };
      await dataSource.query(
        `CREATE FUNCTION refuse_outbox_itest() RETURNS trigger LANGUAGE plpgsql AS
           $$ BEGIN RAISE EXCEPTION 'outbox refused by the test'; END $$`,
      );
      try {
        const postponement = new DeclareOutcome(
          dateId,
          {
            outcome: DateOutcome.POSTPONED,
            message: MESSAGE,
            rescheduledTo: '2026-11-20T19:30:00.000Z',
            expectedVersion: 2,
          },
          null,
          idempotency(`${dateId}:postponed`),
        );
        await commands.execute(postponement);
        expect(delivered.map((event) => event.constructor)).toEqual([
          DateOutcomeDeclared,
          DateRescheduled,
        ]);
        expect(await Promise.all(committedWhenDelivered)).toEqual([
          DateOutcome.POSTPONED,
          DateOutcome.POSTPONED,
        ]);

        expect((await commands.execute(postponement)).replayed).toBe(true);
        await refusalOf(declare(dateId, DateOutcome.CANCELLED, 2));
        expect(delivered).toHaveLength(2);

        await refuseOutbox(true);
        await expect(declare(dateId, DateOutcome.CANCELLED, 3)).rejects.toThrow(
          'outbox refused by the test',
        );
        expect(delivered).toHaveLength(2);
        expect(await outcomeCommitted()).toBe(DateOutcome.POSTPONED);
      } finally {
        subscription.unsubscribe();
        readsFirst.mockRestore();
        await refuseOutbox(false).catch(() => undefined);
        await dataSource.query('DROP FUNCTION refuse_outbox_itest()');
      }
    },
    CASE_MS,
  );
});

describe('an artist’s page', () => {
  const ORIGIN = 'https://arthome.test';
  const clock = new FixedClock('2026-09-26T10:00:00.000Z');

  it(
    'names the artist on its channel’s cards, and lists the channel’s dates by what they show',
    async () => {
      const face = await commands.execute(
        new UpdateChannelIdentity(
          CHANNEL,
          {
            expectedVersion: 0,
            publicName: 'Compagnie Verticale',
            categoryId: 'theatre',
            biography: [{ contentLanguage: Locale.FR, text: 'Une compagnie.' }],
          },
          null,
          idempotency('artist-face'),
        ),
      );
      const artistId = face.envelope.data.artistId;

      const published = '01a0e100-0000-7000-8000-0000000006a1';
      await draft(published);
      await satisfyProjectedItems(published);
      await move(published, PublicationState.SCHEDULED, 1, PublicationPromise.PRICES_ENGAGED);

      const card = (
        await publicQueryBus(dataSource, clock, ORIGIN).execute(new GetDateDetail(published))
      ).data;
      expect(card.artist).toEqual({ id: artistId, name: 'Compagnie Verticale' });

      const { data: page } = await publicQueryBus(dataSource, clock, ORIGIN).execute(
        new GetArtistDetail(artistId),
      );
      expect(page).toMatchObject({
        id: artistId,
        name: 'Compagnie Verticale',
        slug: 'compagnie-verticale',
        biography: { contentLanguage: Locale.FR, text: 'Une compagnie.' },
      });
      const upcoming = (page.upcomingDates ?? []).map((date) => date.id);
      const past = (page.pastDates ?? []).map((date) => date.id);
      expect(upcoming).toContain(published);
      // The cancelled date of the outcome cases is this channel's too, and it is over for good.
      expect(past).toContain('01a0e100-0000-7000-8000-0000000005a2');

      const resolved = await publicQueryBus(dataSource, clock, ORIGIN).execute(
        new ResolvePublicLink({ url: `${ORIGIN}/a/compagnie-verticale` }),
      );
      expect(resolved.data).toMatchObject({
        kind: LinkKind.ARTIST,
        id: artistId,
        canonicalUrl: `${ORIGIN}/artist/compagnie-verticale`,
      });
    },
    CASE_MS,
  );
});
