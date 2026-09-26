import {
  DateDraftedSchema,
  PublicationState as WirePublicationState,
  PublicationStateChangedSchema,
} from '@arthome-platform/events';
import { RefusalException } from '@arthome-platform/http-edge';
import { OutboxEvent } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ApiErrorCode,
  DomainErrorCode,
  FixedClock,
  LanguageDependency,
  PublicationChecklistItem,
  PublicationPromise,
  PublicationState,
  ReplayPolicy,
} from '@arthome/core';

import { DatesService, type TransitionPublicationCommand } from './dates.service.js';
import { PerformanceDate } from './performance-date.entity.js';
import { PublicationChecklistFact } from './publication-checklist-fact.entity.js';
import { Publication } from './publication.entity.js';
import { Show } from '../catalog/show.entity.js';
import type { IdempotentRequest } from '../idempotency/idempotency.js';
import { Initial1758800000000 } from '../migrations/1758800000000-initial.js';
import { Idempotency1790420000000 } from '../migrations/1790420000000-idempotency.js';
import { ShowCopyAndVenue1790420100000 } from '../migrations/1790420100000-show-copy-and-venue.js';
import { DateAndPublication1790420200000 } from '../migrations/1790420200000-date-and-publication.js';
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
let dates: DatesService;
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
  return dates.draft(
    {
      channelId: CHANNEL,
      dateId,
      showId: SHOW_ID,
      venueId: VENUE_ID,
      startsAt: '2026-11-04T19:30:00.000Z',
      replayPolicy: ReplayPolicy.INCLUDED,
      replayWindowHours: 72,
      traceparent: null,
    },
    key,
  );
}

function move(
  dateId: string,
  to: PublicationState,
  expectedVersion: number,
  acknowledgedPromise: PublicationPromise | null = null,
) {
  const command: TransitionPublicationCommand = {
    dateId,
    to,
    expectedVersion,
    acknowledgedPromise,
    traceparent: null,
  };
  return dates.transition(command, idempotency(`${dateId}:${to}:${expectedVersion}`));
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

function outboxRowsFor(dateId: string): Promise<OutboxEvent[]> {
  return dataSource.getRepository(OutboxEvent).find({
    where: { aggregateid: dateId },
    order: { created_at: 'ASC', id: 'ASC' },
  });
}

async function satisfyProjectedItems(dateId: string): Promise<void> {
  await dataSource
    .getRepository(PublicationChecklistFact)
    .insert(
      [
        PublicationChecklistItem.AT_LEAST_ONE_ACTIVE_PRICE,
        PublicationChecklistItem.CAPACITY,
        PublicationChecklistItem.TECHNICAL_CHECK_PASSED,
        PublicationChecklistItem.CHAT_MODE_SET,
      ].map((item) => ({ date_id: dateId, item, satisfied: true })),
    );
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'catalog_dates_itest');
  dataSource = await applyMigrations(database, {
    entities: [Show, Venue, PerformanceDate, Publication, PublicationChecklistFact, OutboxEvent],
    migrations: [
      Initial1758800000000,
      Idempotency1790420000000,
      ShowCopyAndVenue1790420100000,
      DateAndPublication1790420200000,
    ],
  });
  await dataSource.getRepository(Show).insert({
    id: SHOW_ID,
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
  dates = new DatesService(dataSource, new FixedClock('2026-09-26T10:00:00.000Z'));
}, STARTUP_MS);

afterAll(async () => {
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
      expect(again.envelope).toEqual(first.envelope);
      expect(await outboxRowsFor(dateId)).toHaveLength(1);
    },
    CASE_MS,
  );

  it(
    'refuses another channel’s show, naming the field',
    async () => {
      const refusal = await refusalOf(
        dates.draft(
          {
            channelId: 'someone-else',
            dateId: '01a0e100-0000-7000-8000-000000000103',
            showId: SHOW_ID,
            venueId: VENUE_ID,
            startsAt: '2026-11-04T19:30:00.000Z',
            replayPolicy: ReplayPolicy.NONE,
            replayWindowHours: null,
            traceparent: null,
          },
          idempotency('other-channel'),
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
      const changed = fromBinary(
        PublicationStateChangedSchema,
        rows.at(-1)?.payload ?? new Uint8Array(),
      );
      expect(changed.irreversible).toBe(true);

      const back = await refusalOf(move(dateId, PublicationState.DRAFT, 2));
      expect(back.refusal).toMatchObject({
        code: DomainErrorCode.PUBLICATION_TRANSITION_IRREVERSIBLE,
        params: { promise: PublicationPromise.PRICES_ENGAGED },
      });
    },
    CASE_MS,
  );
});
