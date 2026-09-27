import {
  ErrorEnvelopeFilter,
  SuccessEnvelopeInterceptor,
  schemaInvalidException,
} from '@arthome-platform/http-edge';
import { OutboxEvent, ProcessedMessage } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { StandardSchemaValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, HttpAdapterHost } from '@nestjs/core';
import { CqrsModule } from '@nestjs/cqrs';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DateOutcome,
  DomainErrorCode,
  FailureNature,
  FixedClock,
  LanguageDependency,
  Locale,
  PublicationChecklistItem,
  PublicationPromise,
  PublicationState,
  ReplayPolicy,
} from '@arthome/core';

import { DatesModule } from './dates.module.js';
import { PerformanceDateRow } from './performance-date.entity.js';
import { PublicationChecklistFact } from './publication-checklist-fact.entity.js';
import { PublicationRow } from './publication.entity.js';
import { Artist } from '../artists/artist.entity.js';
import { Show } from '../catalog/show.entity.js';
import { CLOCK } from '../clock.js';
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
import { DateDetailPublic } from '../public/date-detail-public.entity.js';
import { SlugAlias } from '../public/slug-alias.entity.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { Venue } from '../venues/venue.entity.js';

/**
 * The date routes through the module graph the service boots, over HTTP: a handler missing from
 * `DatesModule` or a bus the graph cannot resolve fails here, not at the first request in
 * production. What each command decides is `dates.itest.ts`'s.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const NOW = '2026-09-26T10:00:00.000Z';
const ORIGIN = 'https://arthome.test';
const CHANNEL = 'channel-http';
const SHOW_ID = '01a0e300-0000-7000-8000-000000000001';
const VENUE_ID = '01a0e300-0000-7000-8000-000000000002';
const DATE_ID = '01a0e300-0000-7000-8000-000000000101';

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let keys = 0;

function post(url: string, payload: object, key = nextKey()) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    payload,
  });
}

function nextKey(): string {
  keys += 1;
  return `01a0e3ff-0000-7000-8000-${String(keys).padStart(12, '0')}`;
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'catalog_dates_http_itest');
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
    slug: 'port',
    channel_id: CHANNEL,
    artist_id: 'artist-http',
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
  await dataSource.getRepository(Venue).insert({
    id: VENUE_ID,
    name: 'Théâtre du Port',
    city: 'Marseille',
    country: 'FR',
    time_zone: 'Europe/Paris',
  });

  const clock = new FixedClock(NOW);
  const moduleRef = await Test.createTestingModule({
    imports: [
      // The harness's DataSource, so the app and the seeding share one pool on the migrated schema.
      TypeOrmModule.forRootAsync({
        useFactory: () => dataSource.options,
        dataSourceFactory: () => Promise.resolve(dataSource),
      }),
      CqrsModule.forRoot(),
      DatesModule,
    ],
    providers: [
      {
        provide: APP_PIPE,
        useValue: new StandardSchemaValidationPipe({ exceptionFactory: schemaInvalidException }),
      },
      {
        provide: APP_FILTER,
        inject: [HttpAdapterHost],
        useFactory: (host: HttpAdapterHost): ErrorEnvelopeFilter =>
          new ErrorEnvelopeFilter(host, clock),
      },
      { provide: APP_INTERCEPTOR, useValue: new SuccessEnvelopeInterceptor(clock) },
    ],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .overrideProvider(PUBLIC_WEB_ORIGIN)
    .useValue(ORIGIN)
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, STARTUP_MS);

// Closing the app destroys the DataSource the TypeORM module was handed.
afterAll(async () => {
  await app?.close();
  await stack?.stop();
});

describe('the date routes over HTTP', () => {
  it(
    'postpones a published date, replays it under its key, refuses a stale screen, serves the sheet',
    async () => {
      const drafted = await post(`/channels/${CHANNEL}/dates`, {
        dateId: DATE_ID,
        showId: SHOW_ID,
        venueId: VENUE_ID,
        startsAt: '2026-11-04T19:30:00.000Z',
        replayPolicy: ReplayPolicy.INCLUDED,
        replayWindowHours: 72,
      });
      expect(drafted.statusCode).toBe(201);
      await dataSource.getRepository(PublicationChecklistFact).insert(
        [
          PublicationChecklistItem.AT_LEAST_ONE_ACTIVE_PRICE,
          PublicationChecklistItem.CAPACITY,
          PublicationChecklistItem.TECHNICAL_CHECK_PASSED,
          PublicationChecklistItem.CHAT_MODE_SET,
        ].map((item) => ({
          date_id: DATE_ID,
          item,
          satisfied: true,
          occurred_at: new Date(NOW),
        })),
      );
      const published = await post(`/dates/${DATE_ID}/publication/transitions`, {
        to: PublicationState.SCHEDULED,
        expectedVersion: 1,
        acknowledgedPromiseCode: PublicationPromise.PRICES_ENGAGED,
      });
      expect(published.statusCode).toBe(200);

      const outcomeUrl = `/v1/dates/${DATE_ID}/outcome`;
      const postponement = {
        outcome: DateOutcome.POSTPONED,
        message: { contentLanguage: Locale.FR, text: 'Report au 12 novembre.' },
        rescheduledTo: '2026-11-12T19:30:00.000Z',
        expectedVersion: 2,
      };
      const key = nextKey();
      const postponed = await post(outcomeUrl, postponement, key);
      expect(postponed.statusCode).toBe(200);
      expect(postponed.headers['cache-control']).toBe('no-store');
      expect(postponed.json()).toEqual({
        servedAt: NOW,
        data: { outcome: DateOutcome.POSTPONED, declaredAt: NOW },
      });

      const replayed = await post(outcomeUrl, postponement, key);
      expect(replayed.statusCode).toBe(200);
      expect(replayed.headers['idempotency-replayed']).toBe('true');
      expect(replayed.body).toBe(postponed.body);

      const stale = await post(outcomeUrl, {
        ...postponement,
        outcome: DateOutcome.CANCELLED,
        rescheduledTo: null,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({
        error: {
          code: DomainErrorCode.STATE_CONFLICT,
          nature: FailureNature.REFUSED,
          params: { state: PublicationState.SCHEDULED, version: 3 },
        },
      });

      const sheet = await app.inject({ method: 'GET', url: `/dates/${DATE_ID}` });
      expect(sheet.statusCode).toBe(200);
      expect(sheet.json()).toMatchObject({
        servedAt: NOW,
        data: {
          startsAt: '2026-11-12T19:30:00.000Z',
          canonicalUrl: `${ORIGIN}/show/port/date/2026-11-12`,
          publication: { state: PublicationState.SCHEDULED, version: 3 },
        },
      });
      const missing = await app.inject({
        method: 'GET',
        url: '/dates/01a0e300-0000-7000-8000-0000000009ff',
      });
      expect(missing.statusCode).toBe(404);
    },
    CASE_MS,
  );
});
