import {
  ChatMode,
  DateChatPolicyChangedSchema,
  DateSalesCapacitySetSchema,
  DateSalesPricingChangedSchema,
  PriceTier,
  PublicationState as WirePublicationState,
  PublicationStateChangedSchema,
  RunEndedSchema,
  RunStartedSchema,
  TechnicalCheckPassedSchema,
} from '@arthome-platform/events';
import type { IdempotentRequest } from '@arthome-platform/http-edge';
import {
  ATTEMPT_HEADER,
  DLQ_REASON_HEADER,
  ERROR_HEADER,
  OutboxEvent,
  Outcome,
  deadLetterTopic,
  dispatch,
  retryTopic,
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
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import type { EachMessagePayload, Producer, ProducerRecord } from 'kafkajs';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DateOutcome,
  FixedClock,
  LanguageDependency,
  Locale,
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
import { LearnRunFactHandler } from './learn-run-fact.handler.js';
import { PublicationRow } from './publication.entity.js';
import { RecordChecklistFactHandler } from './record-checklist-fact.handler.js';
import { applyRunMessage } from './run-consumer.js';
import { TransitionPublication } from './transition-publication.command.js';
import { TransitionPublicationHandler } from './transition-publication.handler.js';
import type { TransitionPublicationBody } from './transition-publication.schema.js';
import { Show } from '../catalog/show.entity.js';
import { CatalogTransactions } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { untilBlockedOrSettled } from '../itest/lock-waits.js';
import { CATALOG_SCHEMA } from '../itest/schema.js';
import { DateDetailPublic } from '../public/date-detail-public.entity.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { Venue } from '../venues/venue.entity.js';

/** The run facts against a real Postgres: what each one leaves in the publication, the public row and the outbox. */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const CHANNEL = 'channel-run';
const SHOW_ID = '01a0ea00-0000-7000-8000-000000000001';
const VENUE_ID = '01a0ea00-0000-7000-8000-000000000002';

let stack: StartedStack;
let dataSource: DataSource;
let cqrs: TestingModule;
let commands: CommandBus;
let keys = 0;
let messages = 0;

function idempotency(fingerprint: string): IdempotentRequest {
  keys += 1;
  return {
    key: `01a0eaff-0000-7000-8000-${String(keys).padStart(12, '0')}`,
    accountId: null,
    fingerprint,
    statusCode: 200,
  };
}

function dateIdOf(n: number): string {
  return `01a0ea00-0000-7000-8000-${String(1000 + n).padStart(12, '0')}`;
}

function reported<Desc extends DescMessage>(
  topic: string,
  type: string,
  schema: Desc,
  init: MessageInitShape<Desc>,
  messageId = `01a0eaee-0000-7000-8000-${String((messages += 1)).padStart(12, '0')}`,
): EachMessagePayload {
  return {
    topic,
    partition: 0,
    message: {
      key: Buffer.from('date'),
      value: Buffer.from(toBinary(schema, create(schema, init))),
      headers: { 'message-id': Buffer.from(messageId), type: Buffer.from(type) },
    },
  } as unknown as EachMessagePayload;
}

const RUN_TOPIC = 'arthome.streaming.run';
const AT = timestampFromDate(new Date('2026-09-26T09:00:00.000Z'));

function runStarted(dateId: string, messageId?: string): EachMessagePayload {
  return reported(
    RUN_TOPIC,
    'streaming.run.started.v1',
    RunStartedSchema,
    { dateId, startedAt: AT },
    messageId,
  );
}

function runEnded(dateId: string, messageId?: string): EachMessagePayload {
  return reported(
    RUN_TOPIC,
    'streaming.run.ended.v1',
    RunEndedSchema,
    { dateId, endedAt: AT, occurredAt: AT },
    messageId,
  );
}

function move(dateId: string, to: TransitionPublicationBody['to'], expectedVersion: number) {
  return commands.execute(
    new TransitionPublication(
      dateId,
      {
        to,
        expectedVersion,
        acknowledgedPromiseCode:
          to === PublicationState.SCHEDULED && expectedVersion === 1
            ? PublicationPromise.PRICES_ENGAGED
            : null,
      },
      null,
      idempotency(`${dateId}:${to}:${expectedVersion}`),
    ),
  );
}

/** Drafted, published and moved to technical check: version 3. */
async function underTechnicalCheck(dateId: string): Promise<void> {
  await commands.execute(
    new DraftDate(
      CHANNEL,
      {
        dateId,
        showId: SHOW_ID,
        venueId: VENUE_ID,
        startsAt: '2027-02-01T19:00:00.000Z',
        replayPolicy: ReplayPolicy.INCLUDED,
        replayWindowHours: 72,
      },
      null,
      idempotency(`draft:${dateId}`),
    ),
  );
  for (const payload of [
    reported(
      'arthome.ticketing.date_sales',
      'ticketing.date_sales.pricing_changed.v1',
      DateSalesPricingChangedSchema,
      { dateId, tiers: [{ tier: PriceTier.FULL, active: true }], occurredAt: AT },
    ),
    reported(
      'arthome.ticketing.date_sales',
      'ticketing.date_sales.capacity_set.v1',
      DateSalesCapacitySetSchema,
      { dateId, capacityTotal: 300, occurredAt: AT },
    ),
    reported(RUN_TOPIC, 'streaming.run.technical_check_passed.v1', TechnicalCheckPassedSchema, {
      dateId,
      passedAt: AT,
    }),
    reported('arthome.chat.date', 'chat.date_chat_policy.changed.v1', DateChatPolicyChangedSchema, {
      dateId,
      mode: ChatMode.OPEN,
      occurredAt: AT,
    }),
  ]) {
    await applyChecklistMessage(commands, payload);
  }
  await move(dateId, PublicationState.SCHEDULED, 1);
  await move(dateId, PublicationState.TECHNICAL, 2);
}

async function publicationOf(dateId: string): Promise<{ state: string; version: number }> {
  const row = await dataSource.getRepository(PublicationRow).findOneByOrFail({ date_id: dateId });
  return { state: row.state, version: row.version };
}

async function publicStateOf(dateId: string): Promise<string> {
  const row = await dataSource.getRepository(DateDetailPublic).findOneByOrFail({ date_id: dateId });
  return row.publication_state;
}

function stateChangesOf(dateId: string): Promise<OutboxEvent[]> {
  return dataSource.getRepository(OutboxEvent).find({
    where: { aggregateid: dateId, type: 'catalog.publication.state_changed.v1' },
    order: { created_at: 'ASC', id: 'ASC' },
  });
}

function recordingProducer(): { producer: Producer; sent: ProducerRecord[] } {
  const sent: ProducerRecord[] = [];
  const producer = {
    send: (record: ProducerRecord) => {
      sent.push(record);
      return Promise.resolve([]);
    },
  } as unknown as Producer;
  return { producer, sent };
}

function consumed(payload: EachMessagePayload) {
  const { producer, sent } = recordingProducer();
  return {
    sent,
    disposition: dispatch(
      (message) => applyRunMessage(commands, message),
      producer,
      Service.CATALOG,
      payload,
      new Date(),
    ),
  };
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'catalog_run_facts_itest');
  dataSource = await applyMigrations(database, CATALOG_SCHEMA);
  await dataSource.getRepository(Show).insert({
    id: SHOW_ID,
    slug: 'nuit-run',
    channel_id: CHANNEL,
    artist_id: 'artist-run',
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
    title: { fr: 'Nuit run', en: '' },
    synopsis: { fr: 'Une nuit.', en: '' },
  });
  await dataSource.getRepository(Venue).insert({
    id: VENUE_ID,
    name: 'Salle',
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
      LearnRunFactHandler,
      RecordChecklistFactHandler,
      TransitionPublicationHandler,
      { provide: DataSource, useValue: dataSource },
      { provide: CLOCK, useValue: new FixedClock('2026-09-26T10:00:00.000Z') },
      { provide: PUBLIC_WEB_ORIGIN, useValue: 'https://arthome.test' },
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

describe('a run started', () => {
  it(
    'makes a date under technical check live, in its publication, its public row and its topic',
    async () => {
      const dateId = dateIdOf(1);
      await underTechnicalCheck(dateId);

      expect(await consumed(runStarted(dateId)).disposition).toBe(Outcome.APPLIED);

      expect(await publicationOf(dateId)).toEqual({ state: PublicationState.LIVE, version: 4 });
      expect(await publicStateOf(dateId)).toBe(PublicationState.LIVE);
      const changes = await stateChangesOf(dateId);
      const last = fromBinary(
        PublicationStateChangedSchema,
        changes.at(-1)?.payload ?? new Uint8Array(),
      );
      expect(last).toMatchObject({
        dateId,
        fromState: WirePublicationState.TECHNICAL,
        toState: WirePublicationState.LIVE,
        version: 4n,
        irreversible: false,
      });
    },
    CASE_MS,
  );

  it(
    'publishes nothing more when the same message comes again',
    async () => {
      const dateId = dateIdOf(2);
      await underTechnicalCheck(dateId);
      const messageId = '01a0eaee-0000-7000-8000-00000000f002';
      await consumed(runStarted(dateId, messageId)).disposition;
      const before = (await stateChangesOf(dateId)).length;

      expect(await consumed(runStarted(dateId, messageId)).disposition).toBe(Outcome.DUPLICATE);

      expect(await stateChangesOf(dateId)).toHaveLength(before);
      expect(await publicationOf(dateId)).toEqual({ state: PublicationState.LIVE, version: 4 });
    },
    CASE_MS,
  );

  it(
    'is ignored by a date already live, under another message',
    async () => {
      const dateId = dateIdOf(3);
      await underTechnicalCheck(dateId);
      await consumed(runStarted(dateId)).disposition;

      expect(await consumed(runStarted(dateId)).disposition).toBe(Outcome.IGNORED);
      expect(await publicationOf(dateId)).toEqual({ state: PublicationState.LIVE, version: 4 });
    },
    CASE_MS,
  );

  it(
    'is dead-lettered with its code on a date still scheduled',
    async () => {
      const dateId = dateIdOf(4);
      await underTechnicalCheck(dateId);
      await move(dateId, PublicationState.SCHEDULED, 3);
      const { producer, sent } = recordingProducer();

      const disposition = await dispatch(
        (message) => applyRunMessage(commands, message),
        producer,
        Service.CATALOG,
        runStarted(dateId),
        new Date(),
      );

      expect(disposition).toBe('dead-lettered');
      expect(sent.map((record) => record.topic)).toEqual([deadLetterTopic(Service.CATALOG)]);
      expect(sent[0]?.messages[0]?.headers).toMatchObject({ [DLQ_REASON_HEADER]: 'permanent' });
      expect(String(sent[0]?.messages[0]?.headers?.[ERROR_HEADER])).toContain(
        'refused publication.transition_forbidden',
      );
      expect(await publicationOf(dateId)).toEqual({
        state: PublicationState.SCHEDULED,
        version: 4,
      });
    },
    CASE_MS,
  );

  it(
    'is dead-lettered for a date catalog never drafted',
    async () => {
      const { disposition } = consumed(runStarted(dateIdOf(99)));

      expect(await disposition).toBe('dead-lettered');
    },
    CASE_MS,
  );

  it(
    'applies on the version a studio write committed while it waited, instead of failing',
    async () => {
      const dateId = dateIdOf(5);
      await underTechnicalCheck(dateId);
      const studio = dataSource.createQueryRunner();
      await studio.connect();
      await studio.startTransaction();
      let learning: Promise<unknown> | undefined;
      try {
        await studio.manager.findOneOrFail(PublicationRow, {
          where: { date_id: dateId },
          lock: { mode: 'pessimistic_write' },
        });
        learning = consumed(runStarted(dateId)).disposition;
        await untilBlockedOrSettled(dataSource, learning);
        await studio.manager.update(PublicationRow, { date_id: dateId }, { version: 4 });
        await studio.commitTransaction();
      } finally {
        await studio.release();
      }

      expect(await learning).toBe(Outcome.APPLIED);
      expect(await publicationOf(dateId)).toEqual({ state: PublicationState.LIVE, version: 5 });
    },
    CASE_MS,
  );
});

describe('a run ended', () => {
  it(
    'makes a live date ended, a cancelled one included',
    async () => {
      const dateId = dateIdOf(10);
      await underTechnicalCheck(dateId);
      await consumed(runStarted(dateId)).disposition;
      await commands.execute(
        new DeclareOutcome(
          dateId,
          {
            outcome: DateOutcome.CANCELLED,
            message: { contentLanguage: Locale.FR, text: 'Annulé.' },
            rescheduledTo: null,
            expectedVersion: 4,
          },
          null,
          idempotency(`cancel:${dateId}`),
        ),
      );

      expect(await consumed(runEnded(dateId)).disposition).toBe(Outcome.APPLIED);

      expect(await publicationOf(dateId)).toEqual({ state: PublicationState.ENDED, version: 6 });
      expect(await publicStateOf(dateId)).toBe(PublicationState.ENDED);
    },
    CASE_MS,
  );

  it(
    'is retried when it arrives before its start, and applied after it',
    async () => {
      const dateId = dateIdOf(11);
      await underTechnicalCheck(dateId);
      const messageId = '01a0eaee-0000-7000-8000-00000000f011';

      const early = consumed(runEnded(dateId, messageId));
      expect(await early.disposition).toBe('retried');
      expect(early.sent.map((record) => record.topic)).toEqual([retryTopic(Service.CATALOG)]);
      expect(early.sent[0]?.messages[0]?.headers?.[ATTEMPT_HEADER]).toBe('1');
      expect(await publicationOf(dateId)).toEqual({
        state: PublicationState.TECHNICAL,
        version: 3,
      });

      expect(await consumed(runStarted(dateId)).disposition).toBe(Outcome.APPLIED);
      expect(await consumed(runEnded(dateId, messageId)).disposition).toBe(Outcome.APPLIED);
      expect(await publicationOf(dateId)).toEqual({ state: PublicationState.ENDED, version: 5 });
    },
    CASE_MS,
  );

  it(
    'is ignored by a date already ended',
    async () => {
      const dateId = dateIdOf(12);
      await underTechnicalCheck(dateId);
      await consumed(runStarted(dateId)).disposition;
      await consumed(runEnded(dateId)).disposition;

      expect(await consumed(runEnded(dateId)).disposition).toBe(Outcome.IGNORED);
      expect(await publicationOf(dateId)).toEqual({ state: PublicationState.ENDED, version: 5 });
    },
    CASE_MS,
  );
});
