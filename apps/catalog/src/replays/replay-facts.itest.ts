import {
  ChatMode,
  DateChatPolicyChangedSchema,
  DateSalesCapacitySetSchema,
  DateSalesPricingChangedSchema,
  PriceTier,
  PublicationState as WirePublicationState,
  PublicationStateChangedSchema,
  ReplayAssetReadySchema,
  ReplayExpiredSchema,
  ReplayPolicy as WireReplayPolicy,
  ReplayState as WireReplayState,
  ReplayStateChangedSchema,
  RunEndedSchema,
  RunStartedSchema,
  TechnicalCheckPassedSchema,
} from '@arthome-platform/events';
import type { IdempotentRequest } from '@arthome-platform/http-edge';
import {
  OutboxEvent,
  Outcome,
  dispatch,
  retryTopic,
  type Disposition,
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
import { timestampDate, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import type { EachMessagePayload, Producer, ProducerRecord } from 'kafkajs';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CatalogErrorCode,
  DateOutcome,
  DisplayState,
  FixedClock,
  LanguageDependency,
  Locale,
  PublicationPromise,
  PublicationState,
  ReplayPolicy,
  ReplayState,
  Service,
  isDomainError,
} from '@arthome/core';

import { LearnReplayAssetFactHandler } from './learn-replay-asset-fact.handler.js';
import { ReplayRow } from './replay.entity.js';
import { Show } from '../catalog/show.entity.js';
import { CatalogTransactions } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { applyChecklistMessage } from '../dates/checklist-consumer.js';
import { DeclareOutcome } from '../dates/declare-outcome.command.js';
import { DeclareOutcomeHandler } from '../dates/declare-outcome.handler.js';
import { DraftDate } from '../dates/draft-date.command.js';
import { DraftDateHandler } from '../dates/draft-date.handler.js';
import { LearnRunFactHandler } from '../dates/learn-run-fact.handler.js';
import { PublicationRow } from '../dates/publication.entity.js';
import { RecordChecklistFactHandler } from '../dates/record-checklist-fact.handler.js';
import { applyRunMessage } from '../dates/run-consumer.js';
import { TransitionPublication } from '../dates/transition-publication.command.js';
import { TransitionPublicationHandler } from '../dates/transition-publication.handler.js';
import type { TransitionPublicationBody } from '../dates/transition-publication.schema.js';
import { CATALOG_SCHEMA } from '../itest/schema.js';
import { dateCardOf } from '../public/date-card.js';
import { DateDetailPublic } from '../public/date-detail-public.entity.js';
import { publicDateOfRow } from '../public/date-detail.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { Venue } from '../venues/venue.entity.js';

/** The `Replay` against a real Postgres: what each fact and command leaves in its row, the public row and the outbox. */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const ORIGIN = 'https://arthome.test';
const CHANNEL = 'channel-replay';
const SHOW_ID = '01a0eb00-0000-7000-8000-000000000001';
const VENUE_ID = '01a0eb00-0000-7000-8000-000000000002';
const NOW = '2026-09-26T10:00:00.000Z';
/** Started by the clock, so an interruption is declarable; ends at 11:05, so a cancellation too. */
const STARTS_AT = '2026-09-26T09:30:00.000Z';
const ENDED_AT = '2026-09-26T09:58:00.000Z';
const CLOSES_AT = '2026-09-29T09:58:00.000Z';
const FILE_FROM = '2026-09-26T09:59:00.000Z';
const RUN_TOPIC = 'arthome.streaming.run';

let stack: StartedStack;
let dataSource: DataSource;
let cqrs: TestingModule;
let commands: CommandBus;
const clock = new FixedClock(NOW);
let keys = 0;
let messages = 0;

function idempotency(fingerprint: string): IdempotentRequest {
  keys += 1;
  return {
    key: `01a0ebff-0000-7000-8000-${String(keys).padStart(12, '0')}`,
    accountId: null,
    fingerprint,
    statusCode: 200,
  };
}

function dateIdOf(n: number): string {
  return `01a0eb00-0000-7000-8000-${String(1000 + n).padStart(12, '0')}`;
}

const timestampOf = (instant: string) => timestampFromDate(new Date(instant));

function reported<Desc extends DescMessage>(
  topic: string,
  type: string,
  schema: Desc,
  init: MessageInitShape<Desc>,
  messageId = `01a0ebee-0000-7000-8000-${String((messages += 1)).padStart(12, '0')}`,
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

const runStarted = (dateId: string) =>
  reported(RUN_TOPIC, 'streaming.run.started.v1', RunStartedSchema, {
    dateId,
    startedAt: timestampOf(STARTS_AT),
  });

const runEnded = (dateId: string) =>
  reported(RUN_TOPIC, 'streaming.run.ended.v1', RunEndedSchema, {
    dateId,
    endedAt: timestampOf(ENDED_AT),
    occurredAt: timestampOf(ENDED_AT),
  });

const assetReady = (dateId: string, messageId?: string) =>
  reported(
    RUN_TOPIC,
    'streaming.replay.asset_ready.v1',
    ReplayAssetReadySchema,
    {
      dateId,
      channelId: CHANNEL,
      durationSec: 5520,
      availableFrom: timestampOf(FILE_FROM),
      expiresAt: timestampOf(CLOSES_AT),
      occurredAt: timestampOf(FILE_FROM),
    },
    messageId,
  );

const expired = (dateId: string) =>
  reported(RUN_TOPIC, 'streaming.replay.expired.v1', ReplayExpiredSchema, {
    dateId,
    occurredAt: timestampOf(NOW),
  });

function promiseAcknowledgedFor(
  to: TransitionPublicationBody['to'],
  expectedVersion: number,
): PublicationPromise | null {
  if (to === PublicationState.REPLAY_ONLINE) return PublicationPromise.REPLAY_SOLD;
  return to === PublicationState.SCHEDULED && expectedVersion === 1
    ? PublicationPromise.PRICES_ENGAGED
    : null;
}

function move(dateId: string, to: TransitionPublicationBody['to'], expectedVersion: number) {
  return commands.execute(
    new TransitionPublication(
      dateId,
      {
        to,
        expectedVersion,
        acknowledgedPromiseCode: promiseAcknowledgedFor(to, expectedVersion),
      },
      null,
      idempotency(`${dateId}:${to}:${expectedVersion}`),
    ),
  );
}

function declare(dateId: string, outcome: DateOutcome, expectedVersion: number) {
  return commands.execute(
    new DeclareOutcome(
      dateId,
      {
        outcome,
        message: { contentLanguage: Locale.FR, text: 'Annonce.' },
        rescheduledTo: null,
        expectedVersion,
      },
      null,
      idempotency(`${outcome}:${dateId}`),
    ),
  );
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

function consumed(payload: EachMessagePayload): {
  sent: ProducerRecord[];
  disposition: Promise<Disposition>;
} {
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

/** Drafted, published and moved to technical check: version 3. */
async function underTechnicalCheck(
  dateId: string,
  replay: { replayPolicy: ReplayPolicy; replayWindowHours: number | null } = {
    replayPolicy: ReplayPolicy.INCLUDED,
    replayWindowHours: 72,
  },
): Promise<void> {
  await commands.execute(
    new DraftDate(
      CHANNEL,
      { dateId, showId: SHOW_ID, venueId: VENUE_ID, startsAt: STARTS_AT, ...replay },
      null,
      idempotency(`draft:${dateId}`),
    ),
  );
  for (const payload of [
    reported(
      'arthome.ticketing.date_sales',
      'ticketing.date_sales.pricing_changed.v1',
      DateSalesPricingChangedSchema,
      { dateId, tiers: [{ tier: PriceTier.FULL, active: true }], occurredAt: timestampOf(NOW) },
    ),
    reported(
      'arthome.ticketing.date_sales',
      'ticketing.date_sales.capacity_set.v1',
      DateSalesCapacitySetSchema,
      { dateId, capacityTotal: 300, occurredAt: timestampOf(NOW) },
    ),
    reported(RUN_TOPIC, 'streaming.run.technical_check_passed.v1', TechnicalCheckPassedSchema, {
      dateId,
      passedAt: timestampOf(NOW),
    }),
    reported('arthome.chat.date', 'chat.date_chat_policy.changed.v1', DateChatPolicyChangedSchema, {
      dateId,
      mode: ChatMode.OPEN,
      occurredAt: timestampOf(NOW),
    }),
  ]) {
    await applyChecklistMessage(commands, payload);
  }
  await move(dateId, PublicationState.SCHEDULED, 1);
  await move(dateId, PublicationState.TECHNICAL, 2);
}

/** On air, then ended: version 5. */
async function ended(dateId: string, replay?: Parameters<typeof underTechnicalCheck>[1]) {
  await underTechnicalCheck(dateId, replay);
  await consumed(runStarted(dateId)).disposition;
  expect(await consumed(runEnded(dateId)).disposition).toBe(Outcome.APPLIED);
}

function replayOf(dateId: string): Promise<ReplayRow | null> {
  return dataSource.getRepository(ReplayRow).findOneBy({ date_id: dateId });
}

async function publicationOf(dateId: string): Promise<{ state: string; version: number }> {
  const row = await dataSource.getRepository(PublicationRow).findOneByOrFail({ date_id: dateId });
  return { state: row.state, version: row.version };
}

async function cardOf(dateId: string) {
  const row = await dataSource.getRepository(DateDetailPublic).findOneByOrFail({ date_id: dateId });
  return dateCardOf(publicDateOfRow(row, ORIGIN), NOW);
}

/** The date's topic as the relay would publish it: its outbox rows, in their order. */
function dateTopicOf(dateId: string): Promise<OutboxEvent[]> {
  return dataSource.getRepository(OutboxEvent).find({
    where: { aggregateid: dateId },
    order: { created_at: 'ASC', id: 'ASC' },
  });
}

async function replayChangesOf(dateId: string) {
  return (await dateTopicOf(dateId))
    .filter((row) => row.type === 'catalog.replay.state_changed.v1')
    .map((row) => fromBinary(ReplayStateChangedSchema, row.payload));
}

async function refusalOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => error,
  );
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'catalog_replay_facts_itest');
  dataSource = await applyMigrations(database, CATALOG_SCHEMA);
  await dataSource.getRepository(Show).insert({
    id: SHOW_ID,
    slug: 'nuit-replay',
    channel_id: CHANNEL,
    artist_id: 'artist-replay',
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
    title: { fr: 'Nuit replay', en: '' },
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
      LearnReplayAssetFactHandler,
      LearnRunFactHandler,
      RecordChecklistFactHandler,
      TransitionPublicationHandler,
      { provide: DataSource, useValue: dataSource },
      { provide: CLOCK, useValue: clock },
      { provide: PUBLIC_WEB_ORIGIN, useValue: ORIGIN },
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

describe('a run ended', () => {
  it(
    'opens a pending replay closing at the real end plus the window, after the publication’s move on the topic',
    async () => {
      const dateId = dateIdOf(1);
      await ended(dateId);

      expect(await replayOf(dateId)).toMatchObject({
        state: ReplayState.PENDING,
        live_ended_at: new Date(ENDED_AT),
        closes_at: new Date(CLOSES_AT),
        online_at: null,
        version: 1,
      });
      const topic = await dateTopicOf(dateId);
      expect(topic.slice(-2).map((row) => row.type)).toEqual([
        'catalog.publication.state_changed.v1',
        'catalog.replay.state_changed.v1',
      ]);
      expect(
        fromBinary(PublicationStateChangedSchema, topic.at(-2)?.payload ?? new Uint8Array()),
      ).toMatchObject({ toState: WirePublicationState.ENDED });
      const [opened] = await replayChangesOf(dateId);
      expect(opened).toMatchObject({
        dateId,
        channelId: CHANNEL,
        fromState: WireReplayState.UNSPECIFIED,
        toState: WireReplayState.PENDING,
        version: 1n,
        policy: WireReplayPolicy.INCLUDED,
      });
      expect([opened?.onlineAt, opened?.durationSec]).toEqual([undefined, undefined]);
      expect(opened?.liveEndedAt && timestampDate(opened.liveEndedAt).toISOString()).toBe(ENDED_AT);
      expect(opened?.closesAt && timestampDate(opened.closesAt).toISOString()).toBe(CLOSES_AT);
      expect(opened?.occurredAt && timestampDate(opened.occurredAt).toISOString()).toBe(NOW);

      const card = await cardOf(dateId);
      expect(card).toMatchObject({
        displayState: DisplayState.ENDED,
        displayStateValidUntil: null,
      });
      expect(card.replay).not.toHaveProperty('expiresAt');
    },
    CASE_MS,
  );

  it(
    'opens none for a date without a replay policy, or interrupted on air',
    async () => {
      const withoutPolicy = dateIdOf(2);
      await ended(withoutPolicy, { replayPolicy: ReplayPolicy.NONE, replayWindowHours: null });

      const interrupted = dateIdOf(3);
      await underTechnicalCheck(interrupted);
      await consumed(runStarted(interrupted)).disposition;
      await declare(interrupted, DateOutcome.INTERRUPTED, 4);
      expect(await consumed(runEnded(interrupted)).disposition).toBe(Outcome.APPLIED);

      expect([await replayOf(withoutPolicy), await replayOf(interrupted)]).toEqual([null, null]);
      expect([
        ...(await replayChangesOf(withoutPolicy)),
        ...(await replayChangesOf(interrupted)),
      ]).toEqual([]);
    },
    CASE_MS,
  );
});

describe('putting a replay online', () => {
  it(
    'is refused before its file is ready',
    async () => {
      const dateId = dateIdOf(10);
      await ended(dateId);

      const refusal = await refusalOf(move(dateId, PublicationState.REPLAY_ONLINE, 5));

      expect(isDomainError(refusal) && refusal.code).toBe(CatalogErrorCode.REPLAY_ASSET_NOT_READY);
      expect(await publicationOf(dateId)).toEqual({ state: PublicationState.ENDED, version: 5 });
      expect(await replayOf(dateId)).toMatchObject({ state: ReplayState.PENDING, version: 1 });
    },
    CASE_MS,
  );

  it(
    'is refused on a date that has no replay',
    async () => {
      const dateId = dateIdOf(11);
      await ended(dateId, { replayPolicy: ReplayPolicy.NONE, replayWindowHours: null });

      const refusal = await refusalOf(move(dateId, PublicationState.REPLAY_ONLINE, 5));

      expect(isDomainError(refusal) && [refusal.code, refusal.params]).toEqual([
        CatalogErrorCode.REPLAY_UNAVAILABLE,
        { replayState: null },
      ]);
      expect(await publicationOf(dateId)).toEqual({ state: PublicationState.ENDED, version: 5 });
    },
    CASE_MS,
  );

  it(
    'is refused once the replay’s window has closed, whatever its file',
    async () => {
      const dateId = dateIdOf(13);
      await ended(dateId);
      await consumed(assetReady(dateId)).disposition;

      const shift = Date.parse(CLOSES_AT) - clock.nowMs();
      clock.advance(shift);
      let refusal: unknown;
      try {
        refusal = await refusalOf(move(dateId, PublicationState.REPLAY_ONLINE, 5));
      } finally {
        clock.advance(-shift);
      }

      expect(isDomainError(refusal) && [refusal.code, refusal.params]).toEqual([
        CatalogErrorCode.REPLAY_UNAVAILABLE,
        { replayState: ReplayState.CLOSED },
      ]);
      expect(await publicationOf(dateId)).toEqual({ state: PublicationState.ENDED, version: 5 });
      expect(await replayOf(dateId)).toMatchObject({ state: ReplayState.PENDING, online_at: null });
    },
    CASE_MS,
  );

  it(
    'is allowed once its file is ready: the card shows replay, its duration and its real closing, and the event carries them',
    async () => {
      const dateId = dateIdOf(12);
      await ended(dateId);
      expect(await consumed(assetReady(dateId)).disposition).toBe(Outcome.APPLIED);
      expect(await replayChangesOf(dateId)).toHaveLength(1);

      await move(dateId, PublicationState.REPLAY_ONLINE, 5);

      expect(await publicationOf(dateId)).toEqual({
        state: PublicationState.REPLAY_ONLINE,
        version: 6,
      });
      expect(await replayOf(dateId)).toMatchObject({
        state: ReplayState.ONLINE,
        asset_duration_sec: 5520,
        asset_ready_at: new Date(FILE_FROM),
        online_at: new Date(NOW),
        version: 3,
      });
      expect(await cardOf(dateId)).toMatchObject({
        displayState: DisplayState.REPLAY,
        displayStateValidUntil: CLOSES_AT,
        replay: { availableFrom: NOW, expiresAt: CLOSES_AT, durationSec: 5520 },
      });
      const topic = await dateTopicOf(dateId);
      expect(topic.slice(-2).map((row) => row.type)).toEqual([
        'catalog.publication.state_changed.v1',
        'catalog.replay.state_changed.v1',
      ]);
      const online = (await replayChangesOf(dateId)).at(-1);
      expect(online).toMatchObject({
        fromState: WireReplayState.PENDING,
        toState: WireReplayState.ONLINE,
        version: 3n,
        durationSec: 5520,
      });
      expect(online?.onlineAt && timestampDate(online.onlineAt).toISOString()).toBe(NOW);
      expect(online?.closesAt && timestampDate(online.closesAt).toISOString()).toBe(CLOSES_AT);
    },
    CASE_MS,
  );
});

describe('the replay’s end', () => {
  it(
    'closes an expired replay, and withdraws one on an outcome declared after the live’s end',
    async () => {
      const expiring = dateIdOf(20);
      await ended(expiring);
      await consumed(assetReady(expiring)).disposition;
      await move(expiring, PublicationState.REPLAY_ONLINE, 5);

      expect(await consumed(expired(expiring)).disposition).toBe(Outcome.APPLIED);

      expect(await replayOf(expiring)).toMatchObject({
        state: ReplayState.CLOSED,
        closed_at: new Date(NOW),
        online_at: new Date(NOW),
      });
      expect((await replayChangesOf(expiring)).at(-1)).toMatchObject({
        fromState: WireReplayState.ONLINE,
        toState: WireReplayState.CLOSED,
        version: 4n,
        durationSec: 5520,
      });
      expect(await cardOf(expiring)).toMatchObject({
        displayState: DisplayState.ENDED,
        replay: { availableFrom: NOW, expiresAt: CLOSES_AT, durationSec: 5520 },
      });

      const interrupted = dateIdOf(22);
      await ended(interrupted);
      await consumed(assetReady(interrupted)).disposition;
      await move(interrupted, PublicationState.REPLAY_ONLINE, 5);
      await declare(interrupted, DateOutcome.INTERRUPTED, 6);

      expect(await replayOf(interrupted)).toMatchObject({
        state: ReplayState.WITHDRAWN,
        online_at: new Date(NOW),
        withdrawn_at: new Date(NOW),
      });
      expect((await replayChangesOf(interrupted)).at(-1)).toMatchObject({
        fromState: WireReplayState.ONLINE,
        toState: WireReplayState.WITHDRAWN,
        durationSec: 5520,
      });
      expect(await cardOf(interrupted)).toMatchObject({ displayState: DisplayState.INTERRUPTED });

      const cancelled = dateIdOf(21);
      await ended(cancelled);
      await declare(cancelled, DateOutcome.CANCELLED, 5);

      expect(await replayOf(cancelled)).toMatchObject({
        state: ReplayState.WITHDRAWN,
        withdrawn_at: new Date(NOW),
      });
      const topic = await dateTopicOf(cancelled);
      expect(topic.slice(-2).map((row) => row.type)).toEqual([
        'catalog.date.outcome_declared.v1',
        'catalog.replay.state_changed.v1',
      ]);
      expect((await replayChangesOf(cancelled)).at(-1)).toMatchObject({
        fromState: WireReplayState.PENDING,
        toState: WireReplayState.WITHDRAWN,
        version: 2n,
      });
      expect(await cardOf(cancelled)).toMatchObject({
        displayState: DisplayState.CANCELLED,
        replay: { policy: ReplayPolicy.INCLUDED, windowHours: 72 },
      });
      expect(await consumed(expired(cancelled)).disposition).toBe(Outcome.IGNORED);
    },
    CASE_MS,
  );
});

describe('a file', () => {
  it(
    'is retried when it comes before its run’s end, then applied',
    async () => {
      const dateId = dateIdOf(30);
      await underTechnicalCheck(dateId);
      await consumed(runStarted(dateId)).disposition;
      const messageId = '01a0ebee-0000-7000-8000-00000000f030';

      const early = consumed(assetReady(dateId, messageId));
      expect(await early.disposition).toBe('retried');
      expect(early.sent.map((record) => record.topic)).toEqual([retryTopic(Service.CATALOG)]);

      expect(await consumed(runEnded(dateId)).disposition).toBe(Outcome.APPLIED);
      expect(await consumed(assetReady(dateId, messageId)).disposition).toBe(Outcome.APPLIED);
      expect(await replayOf(dateId)).toMatchObject({
        state: ReplayState.PENDING,
        asset_ready_at: new Date(FILE_FROM),
        version: 2,
      });
    },
    CASE_MS,
  );

  it(
    'changes nothing when the same message comes twice, and a second run end opens nothing',
    async () => {
      const dateId = dateIdOf(31);
      await ended(dateId);
      const messageId = '01a0ebee-0000-7000-8000-00000000f031';
      await consumed(assetReady(dateId, messageId)).disposition;

      expect(await consumed(assetReady(dateId, messageId)).disposition).toBe(Outcome.DUPLICATE);
      expect(await consumed(assetReady(dateId)).disposition).toBe(Outcome.IGNORED);
      expect(await consumed(runEnded(dateId)).disposition).toBe(Outcome.IGNORED);

      expect(await replayOf(dateId)).toMatchObject({ version: 2 });
      expect(await replayChangesOf(dateId)).toHaveLength(1);
    },
    CASE_MS,
  );

  it(
    'is dead-lettered for a date catalog never drafted, and ignored on a date ended without a replay',
    async () => {
      expect(await consumed(assetReady(dateIdOf(99))).disposition).toBe('dead-lettered');

      const dateId = dateIdOf(32);
      await ended(dateId, { replayPolicy: ReplayPolicy.NONE, replayWindowHours: null });
      expect(await consumed(assetReady(dateId)).disposition).toBe(Outcome.IGNORED);
    },
    CASE_MS,
  );
});
