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
  ApiErrorCode,
  FixedClock,
  LanguageDependency,
  Locale,
  PublicationState,
  ReplayPolicy,
  worldwideRights,
} from '@arthome/core';

import { DateDetailPublic } from './date-detail-public.entity.js';
import { PublicModule } from './public.module.js';
import { LinkKind } from './resolve-query.schema.js';
import { SlugAlias } from './slug-alias.entity.js';
import { Artist } from '../artists/artist.entity.js';
import { Show } from '../catalog/show.entity.js';
import { CLOCK } from '../clock.js';
import { PerformanceDateRow } from '../dates/performance-date.entity.js';
import { PublicationChecklistFact } from '../dates/publication-checklist-fact.entity.js';
import { PublicationRow } from '../dates/publication.entity.js';
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
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { Venue } from '../venues/venue.entity.js';

/**
 * The public reads through the module graph the service boots, over HTTP: a handler missing from
 * `PublicModule` fails here. What each read serves is `dates.itest.ts`'s and `artists.itest.ts`'s.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const NOW = '2026-09-26T10:00:00.000Z';
const DEADLINE = '2026-09-26T10:00:01.000Z';
const ORIGIN = 'https://arthome.test';
const CHANNEL = 'channel-public-http';
const SHOW_ID = '01a0e600-0000-7000-8000-000000000001';
const VENUE_ID = '01a0e600-0000-7000-8000-000000000002';
const ARTIST_ID = '01a0e600-0000-7000-8000-000000000003';
const FIRST_DATE = '01a0e600-0000-7000-8000-000000000101';
const SECOND_DATE = '01a0e600-0000-7000-8000-000000000102';

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;

function get(url: string, deadline: string | null = DEADLINE) {
  return app.inject({
    method: 'GET',
    url,
    headers: deadline === null ? {} : { 'x-arthome-deadline': deadline },
  });
}

function publicRow(dateId: string, startsAt: string, slug: string): DateDetailPublic {
  return dataSource.getRepository(DateDetailPublic).create({
    date_id: dateId,
    show_id: SHOW_ID,
    channel_id: CHANNEL,
    venue_id: VENUE_ID,
    venue_name: 'Théâtre du Port',
    venue_city: 'Marseille',
    venue_country: 'FR',
    venue_timezone: 'Europe/Paris',
    starts_at: new Date(startsAt),
    runtime_min: 95,
    replay_policy: ReplayPolicy.INCLUDED,
    replay_window_hours: 72,
    rights: worldwideRights(),
    show_slug: 'port',
    slug,
    publication_state: PublicationState.SCHEDULED,
    outcome: null,
    artist_name: 'Compagnie du port',
    rescheduled_to: null,
    artist_id: ARTIST_ID,
    category_id: 'theatre',
    genre_ids: [],
    tag_ids: [],
    language_dependency: LanguageDependency.NONE,
    spoken_languages: ['fr-FR'],
    subtitle_languages: [],
    surtitle_languages: [],
    media: {
      wide: [],
      poster: [{ url: 'https://cdn.example.test/p.jpg', widthPx: 480, heightPx: 720 }],
    },
    title: { fr: 'Port', en: '' },
    synopsis: { fr: 'Un port.', en: '' },
  });
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'catalog_public_http_itest');
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
    artist_id: ARTIST_ID,
    category_id: 'theatre',
    genre_ids: [],
    tag_ids: [],
    runtime_min: 95,
    language_dependency: LanguageDependency.NONE,
    spoken_languages: ['fr-FR'],
    subtitle_languages: [],
    surtitle_languages: [],
    media: { wide: [], poster: [] },
    title: { fr: 'Port', en: '' },
    synopsis: { fr: 'Un port.', en: '' },
  });
  await dataSource.getRepository(Artist).insert({
    id: ARTIST_ID,
    channel_id: CHANNEL,
    public_name: 'Compagnie du port',
    slug: 'compagnie-du-port',
    biography: [{ contentLanguage: Locale.FR, text: 'Une compagnie.' }],
    category_id: 'theatre',
    version: 1,
  });
  await dataSource
    .getRepository(DateDetailPublic)
    .insert([
      publicRow(FIRST_DATE, '2026-11-04T19:30:00.000Z', '2026-11-04'),
      publicRow(SECOND_DATE, '2026-11-12T19:30:00.000Z', '2026-11-12'),
    ]);
  await dataSource.getRepository(SlugAlias).insert({
    kind: LinkKind.DATE,
    scope: SHOW_ID,
    slug: '2026-11-01',
    target_id: FIRST_DATE,
    expires_at: new Date('2026-10-20T00:00:00.000Z'),
  });

  const clock = new FixedClock(NOW);
  const moduleRef = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRootAsync({
        useFactory: () => dataSource.options,
        dataSourceFactory: () => Promise.resolve(dataSource),
      }),
      CqrsModule.forRoot(),
      PublicModule,
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

describe('the public reads over HTTP', () => {
  it(
    'serves a date page, refuses one without a deadline, and answers 404 for a date not public',
    async () => {
      const page = await get(`/v1/dates/${FIRST_DATE}`);
      expect(page.statusCode).toBe(200);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.json()).toMatchObject({
        servedAt: NOW,
        validUntil: '2026-11-04T19:00:00.000Z',
        data: {
          id: FIRST_DATE,
          canonicalUrl: `${ORIGIN}/show/port/date/2026-11-04`,
          artist: { id: ARTIST_ID, name: 'Compagnie du port' },
          seriesDates: [{ id: SECOND_DATE }],
          totalSeriesDates: 1,
        },
      });

      const unbounded = await get(`/v1/dates/${FIRST_DATE}`, null);
      expect(unbounded.statusCode).toBe(400);
      expect(unbounded.json()).toMatchObject({
        error: { code: ApiErrorCode.SCHEMA_INVALID, params: { fields: ['x-arthome-deadline'] } },
      });

      const missing = await get('/v1/dates/01a0e600-0000-7000-8000-0000000009ff');
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ error: { code: ApiErrorCode.NOT_FOUND } });
    },
    CASE_MS,
  );

  it(
    'serves an artist page with its channel’s dates',
    async () => {
      const page = await get(`/v1/artists/${ARTIST_ID}`);
      expect(page.statusCode).toBe(200);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.json()).toMatchObject({
        servedAt: NOW,
        data: {
          id: ARTIST_ID,
          name: 'Compagnie du port',
          slug: 'compagnie-du-port',
          upcomingDates: [{ id: FIRST_DATE }, { id: SECOND_DATE }],
        },
      });
    },
    CASE_MS,
  );

  it(
    'resolves a show, an artist and a retired date slug, and refuses a URL sent with a kind',
    async () => {
      const show = await get(`/v1/resolve?url=${encodeURIComponent(`${ORIGIN}/s/port`)}`);
      expect(show.statusCode).toBe(200);
      expect(show.headers['cache-control']).toBe('no-store');
      expect(show.json()).toEqual({
        servedAt: NOW,
        data: { kind: LinkKind.SHOW, id: SHOW_ID, canonicalUrl: `${ORIGIN}/show/port` },
      });

      const artist = await get('/v1/resolve?kind=artist&slug=compagnie-du-port');
      expect(artist.json()).toMatchObject({
        data: {
          kind: LinkKind.ARTIST,
          id: ARTIST_ID,
          canonicalUrl: `${ORIGIN}/artist/compagnie-du-port`,
        },
      });

      const retired = `${ORIGIN}/show/port/date/2026-11-01`;
      const date = await get(`/v1/resolve?url=${encodeURIComponent(retired)}`);
      expect(date.json()).toMatchObject({
        validUntil: '2026-11-04T19:00:00.000Z',
        data: {
          kind: LinkKind.DATE,
          id: FIRST_DATE,
          canonicalUrl: `${ORIGIN}/show/port/date/2026-11-04`,
        },
      });

      const both = await get(`/v1/resolve?url=${encodeURIComponent(retired)}&kind=date`);
      expect(both.statusCode).toBe(400);
      expect(both.json()).toMatchObject({
        error: { code: ApiErrorCode.SCHEMA_INVALID, params: { fields: ['kind'] } },
      });
    },
    CASE_MS,
  );
});
