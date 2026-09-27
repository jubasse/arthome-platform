import {
  ChatMode,
  DateChatPolicyChangedSchema,
  DateSalesCapacitySetSchema,
  DateSalesPricingChangedSchema,
  PriceTier,
  TechnicalCheckPassedSchema,
} from '@arthome-platform/events';
import { OutboxEvent, ProcessedMessage } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { create, toBinary, type DescMessage, type MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import type { EachMessagePayload } from 'kafkajs';
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
} from '@arthome/core';

import { applyChecklistMessage } from './checklist-consumer.js';
import { DeclareOutcome } from './declare-outcome.command.js';
import { DeclareOutcomeHandler } from './declare-outcome.handler.js';
import { DraftDate } from './draft-date.command.js';
import { DraftDateHandler } from './draft-date.handler.js';
import { PerformanceDateRow } from './performance-date.entity.js';
import { PublicationChecklistFact } from './publication-checklist-fact.entity.js';
import { PublicationRow } from './publication.entity.js';
import { RecordChecklistFactHandler } from './record-checklist-fact.handler.js';
import { TransitionPublication } from './transition-publication.command.js';
import { TransitionPublicationHandler } from './transition-publication.handler.js';
import { Artist } from '../artists/artist.entity.js';
import { Show } from '../catalog/show.entity.js';
import { CatalogTransactions } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import type { IdempotentRequest } from '../idempotency/idempotency.js';
import { untilBlockedOrSettled } from '../itest/lock-waits.js';
import { Initial1758800000000 } from '../migrations/1758800000000-initial.js';
import { Idempotency1790420000000 } from '../migrations/1790420000000-idempotency.js';
import { ShowCopyAndVenue1790420100000 } from '../migrations/1790420100000-show-copy-and-venue.js';
import { DateAndPublication1790420200000 } from '../migrations/1790420200000-date-and-publication.js';
import { ChecklistProjection1790420300000 } from '../migrations/1790420300000-checklist-projection.js';
import { DateSlugs1790420400000 } from '../migrations/1790420400000-date-slugs.js';
import { IdempotencyResponseAsJson1790420500000 } from '../migrations/1790420500000-idempotency-response-as-json.js';
import { DateDetailPublic1790420600000 } from '../migrations/1790420600000-date-detail-public.js';
import { DateOutcome1790420700000 } from '../migrations/1790420700000-date-outcome.js';
import { Artist1790420800000 } from '../migrations/1790420800000-artist.js';
import { PublicSlugs1790420900000 } from '../migrations/1790420900000-public-slugs.js';
import { projectArtist, projectShowCopy } from '../public/date-detail-projection.js';
import { DateDetailPublic } from '../public/date-detail-public.entity.js';
import { SlugAlias } from '../public/slug-alias.entity.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { Venue } from '../venues/venue.entity.js';

/**
 * Commands racing on one show's dates, against a real Postgres. A command on a date holds its
 * show's row, so the show's copy it writes and the slug it picks are the ones committed.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const CHANNEL = 'channel-race';
const SHOW_ID = '01a0e900-0000-7000-8000-000000000001';
const VENUE_ID = '01a0e900-0000-7000-8000-000000000002';
const ARTIST_ID = '01a0e900-0000-7000-8000-000000000003';

let stack: StartedStack;
let dataSource: DataSource;
let cqrs: TestingModule;
let commands: CommandBus;
let keys = 0;
let messages = 0;

function idempotency(fingerprint: string): IdempotentRequest {
  keys += 1;
  return {
    key: `01a0e9ff-0000-7000-8000-${String(keys).padStart(12, '0')}`,
    accountId: null,
    fingerprint,
    statusCode: 200,
  };
}

function dateIdOf(n: number): string {
  return `01a0e900-0000-7000-8000-${String(1000 + n).padStart(12, '0')}`;
}

function reported<Desc extends DescMessage>(
  type: string,
  schema: Desc,
  init: MessageInitShape<Desc>,
): EachMessagePayload {
  messages += 1;
  return {
    topic: 'arthome.ticketing.date_sales',
    partition: 0,
    message: {
      key: Buffer.from('date'),
      value: Buffer.from(toBinary(schema, create(schema, init))),
      headers: {
        'message-id': Buffer.from(`01a0e9ee-0000-7000-8000-${String(messages).padStart(12, '0')}`),
        type: Buffer.from(type),
      },
    },
  } as unknown as EachMessagePayload;
}

const AT = timestampFromDate(new Date('2026-09-26T09:00:00.000Z'));

/** Drafted, with the four projected checklist items reported. */
async function publishable(dateId: string, startsAt: string): Promise<void> {
  await commands.execute(
    new DraftDate(
      CHANNEL,
      {
        dateId,
        showId: SHOW_ID,
        venueId: VENUE_ID,
        startsAt,
        replayPolicy: ReplayPolicy.INCLUDED,
        replayWindowHours: 72,
      },
      null,
      idempotency(`draft:${dateId}`),
    ),
  );
  for (const payload of [
    reported('ticketing.date_sales.pricing_changed.v1', DateSalesPricingChangedSchema, {
      dateId,
      tiers: [{ tier: PriceTier.FULL, active: true }],
      occurredAt: AT,
    }),
    reported('ticketing.date_sales.capacity_set.v1', DateSalesCapacitySetSchema, {
      dateId,
      capacityTotal: 300,
      occurredAt: AT,
    }),
    reported('streaming.run.technical_check_passed.v1', TechnicalCheckPassedSchema, {
      dateId,
      passedAt: AT,
    }),
    reported('chat.date_chat_policy.changed.v1', DateChatPolicyChangedSchema, {
      dateId,
      mode: ChatMode.OPEN,
      occurredAt: AT,
    }),
  ]) {
    await applyChecklistMessage(commands, payload);
  }
}

function publish(dateId: string) {
  return commands.execute(
    new TransitionPublication(
      dateId,
      {
        to: PublicationState.SCHEDULED,
        expectedVersion: 1,
        acknowledgedPromiseCode: PublicationPromise.PRICES_ENGAGED,
      },
      null,
      idempotency(`publish:${dateId}`),
    ),
  );
}

function postpone(dateId: string, rescheduledTo: string) {
  return commands.execute(
    new DeclareOutcome(
      dateId,
      {
        outcome: DateOutcome.POSTPONED,
        message: { contentLanguage: Locale.FR, text: 'Reporté.' },
        rescheduledTo,
        expectedVersion: 2,
      },
      null,
      idempotency(`postpone:${dateId}`),
    ),
  );
}

async function slugsOf(dateIds: readonly string[]): Promise<(string | null)[]> {
  const dates = await dataSource
    .getRepository(PerformanceDateRow)
    .findBy(dateIds.map((id) => ({ id })));
  return dates.map((date) => date.slug);
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'catalog_concurrency_itest');
  dataSource = await applyMigrations(database, {
    entities: [
      Show,
      Venue,
      PerformanceDateRow,
      PublicationRow,
      PublicationChecklistFact,
      DateDetailPublic,
      Artist,
      SlugAlias,
      ProcessedMessage,
      OutboxEvent,
    ],
    migrations: [
      Initial1758800000000,
      Idempotency1790420000000,
      ShowCopyAndVenue1790420100000,
      DateAndPublication1790420200000,
      ChecklistProjection1790420300000,
      DateSlugs1790420400000,
      IdempotencyResponseAsJson1790420500000,
      DateDetailPublic1790420600000,
      DateOutcome1790420700000,
      Artist1790420800000,
      PublicSlugs1790420900000,
    ],
  });
  await dataSource.getRepository(Show).insert({
    id: SHOW_ID,
    slug: 'nuit-rouge',
    channel_id: CHANNEL,
    artist_id: 'artist-race',
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
    title: { fr: 'Nuit rouge', en: '' },
    synopsis: { fr: 'Une nuit.', en: '' },
  });
  await dataSource.getRepository(Venue).insert({
    id: VENUE_ID,
    name: 'Salle',
    city: 'Paris',
    country: 'FR',
    time_zone: 'Europe/Paris',
  });
  await dataSource.getRepository(Artist).insert({
    id: ARTIST_ID,
    channel_id: CHANNEL,
    public_name: 'Compagnie Rouge',
    slug: 'compagnie-rouge',
    biography: [],
    category_id: 'theatre',
    version: 1,
  });
  cqrs = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      CatalogTransactions,
      DeclareOutcomeHandler,
      DraftDateHandler,
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

describe('a date published while its show or its channel’s face changes', () => {
  /** `write` runs on its own connection, held open until `publish` has queued behind it. */
  async function publishDuring(
    dateId: string,
    write: (runner: DataSource['manager']) => Promise<void>,
  ): Promise<void> {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let publishing: Promise<unknown> | undefined;
    try {
      await write(runner.manager);
      publishing = publish(dateId);
      await untilBlockedOrSettled(dataSource, publishing);
      await runner.commitTransaction();
    } finally {
      await runner.release();
    }
    await publishing;
  }

  it(
    'carries the show’s title committed while it was published, not the one it replaced',
    async () => {
      const dateId = dateIdOf(1);
      await publishable(dateId, '2027-02-01T19:00:00.000Z');

      // UpdateShowHandler's writes: the show's copy, then every public row of the show.
      await publishDuring(dateId, async (manager) => {
        const show = await manager.findOneByOrFail(Show, { id: SHOW_ID });
        const retitled = { ...show, title: { fr: 'Nuit noire', en: '' } };
        await manager.update(Show, { id: SHOW_ID }, { title: retitled.title });
        await projectShowCopy(manager, retitled);
      });

      const row = await dataSource
        .getRepository(DateDetailPublic)
        .findOneByOrFail({ date_id: dateId });
      expect(row.title).toEqual({ fr: 'Nuit noire', en: '' });
    },
    CASE_MS,
  );

  it(
    'names the artist renamed while it was published, not the name it replaced',
    async () => {
      const dateId = dateIdOf(2);
      await publishable(dateId, '2027-02-02T19:00:00.000Z');

      // UpdateChannelIdentityHandler's writes: the face under its row lock, then the channel's rows.
      await publishDuring(dateId, async (manager) => {
        await manager.findOne(Artist, {
          where: { channel_id: CHANNEL },
          lock: { mode: 'pessimistic_write' },
        });
        await manager.update(Artist, { id: ARTIST_ID }, { public_name: 'Compagnie Noire' });
        await projectArtist(manager, {
          id: ARTIST_ID,
          channel_id: CHANNEL,
          public_name: 'Compagnie Noire',
        });
      });

      const row = await dataSource
        .getRepository(DateDetailPublic)
        .findOneByOrFail({ date_id: dateId });
      expect(row.artist_name).toBe('Compagnie Noire');
    },
    CASE_MS,
  );
});

describe('two dates of one show moved onto one day at once', () => {
  it(
    'publishes both, each under its own slug',
    async () => {
      for (let n = 0; n < 6; n += 1) {
        const pair = [dateIdOf(100 + 2 * n), dateIdOf(101 + 2 * n)];
        const day = `2027-01-${String(10 + n).padStart(2, '0')}T19:00:00.000Z`;
        for (const dateId of pair) await publishable(dateId, day);

        const results = await Promise.allSettled(pair.map((dateId) => publish(dateId)));
        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
        expect(new Set(await slugsOf(pair)).size).toBe(2);
      }
    },
    CASE_MS * 2,
  );

  it(
    'postpones both, each under its own slug',
    async () => {
      for (let n = 0; n < 3; n += 1) {
        const pair = [dateIdOf(200 + 2 * n), dateIdOf(201 + 2 * n)];
        await publishable(
          pair[0] ?? '',
          `2027-03-${String(1 + 2 * n).padStart(2, '0')}T19:00:00.000Z`,
        );
        await publishable(
          pair[1] ?? '',
          `2027-03-${String(2 + 2 * n).padStart(2, '0')}T19:00:00.000Z`,
        );
        for (const dateId of pair) await publish(dateId);

        const day = `2027-04-${String(10 + n).padStart(2, '0')}T19:00:00.000Z`;
        const results = await Promise.allSettled(pair.map((dateId) => postpone(dateId, day)));
        expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
        expect(new Set(await slugsOf(pair)).size).toBe(2);
      }
    },
    CASE_MS * 2,
  );
});
