import { ShowUpdatedSchema } from '@arthome-platform/events';
import {
  ErrorEnvelopeFilter,
  SuccessEnvelopeInterceptor,
  schemaInvalidException,
} from '@arthome-platform/http-edge';
import { OutboxEvent } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
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
  DomainErrorCode,
  FailureNature,
  FixedClock,
  LanguageDependency,
  Locale,
} from '@arthome/core';

import { CatalogModule } from './catalog.module.js';
import { Show } from './show.entity.js';
import { Artist } from '../artists/artist.entity.js';
import { ArtistsModule } from '../artists/artists.module.js';
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
import { Venue } from '../venues/venue.entity.js';
import { VenuesModule } from '../venues/venues.module.js';

/**
 * The show, venue and artist routes through the modules the service boots, over HTTP: a handler
 * missing from its module's `providers` fails here. What each command decides is
 * `publish-show.handler.spec.ts`', `dates.itest.ts`' and `artists.itest.ts`'.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const NOW = '2026-09-27T10:00:00.000Z';
const CHANNEL = 'channel-studio-http';

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;

function send(method: 'POST' | 'PATCH', url: string, payload: object, idempotencyKey?: string) {
  return app.inject({
    method,
    url,
    headers: {
      'content-type': 'application/json',
      ...(idempotencyKey !== undefined && { 'idempotency-key': idempotencyKey }),
    },
    payload,
  });
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'catalog_studio_http_itest');
  dataSource = await applyMigrations(database, {
    entities: [Show, Venue, Artist, DateDetailPublic, SlugAlias, OutboxEvent],
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

  const clock = new FixedClock(NOW);
  const moduleRef = await Test.createTestingModule({
    imports: [
      // The harness's DataSource, so the app and the seeding share one pool on the migrated schema.
      TypeOrmModule.forRootAsync({
        useFactory: () => dataSource.options,
        dataSourceFactory: () => Promise.resolve(dataSource),
      }),
      CqrsModule.forRoot(),
      CatalogModule,
      VenuesModule,
      ArtistsModule,
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

describe('the show, venue and artist routes over HTTP', () => {
  it(
    'creates a venue, refusing a zone this runtime does not know',
    async () => {
      const venue = { name: 'Théâtre du Port', city: 'Marseille', country: 'FR' };
      const created = await send('POST', '/venues', { ...venue, timeZone: 'Europe/Paris' });
      expect(created.statusCode).toBe(201);
      expect(created.headers['cache-control']).toBe('no-store');
      const { venueId } = created.json<{ data: { venueId: string } }>().data;
      expect(await dataSource.getRepository(Venue).findOneBy({ id: venueId })).toMatchObject({
        city: 'Marseille',
        time_zone: 'Europe/Paris',
      });

      const unknown = await send('POST', '/venues', { ...venue, timeZone: 'Mars/Olympus_Mons' });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json()).toMatchObject({
        error: { code: ApiErrorCode.SCHEMA_INVALID, params: { fields: ['timeZone'] } },
      });
    },
    CASE_MS,
  );

  it(
    'publishes a show slugged from its title, updates it, and answers 404 for another',
    async () => {
      const published = await send('POST', '/shows', {
        channelId: CHANNEL,
        artistId: 'artist-studio-http',
        categoryId: 'theatre',
        genreIds: ['contemporary'],
        tagIds: [],
        runtimeMin: 95,
        languageDependency: LanguageDependency.NONE,
        spokenLanguages: ['fr-FR'],
        subtitleLanguages: [],
        surtitleLanguages: [],
        media: {
          wide: [],
          poster: [{ url: 'https://cdn.example.test/p.jpg', widthPx: 480, heightPx: 720 }],
        },
        title: { fr: 'Le port', en: '' },
      });
      expect(published.statusCode).toBe(201);
      const { showId } = published.json<{ data: { showId: string } }>().data;
      expect(await dataSource.getRepository(Show).findOneBy({ id: showId })).toMatchObject({
        slug: 'le-port',
      });

      const updated = await send('PATCH', `/shows/${showId}`, { tagIds: ['late-night'] });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toEqual({ servedAt: NOW, data: { showId } });
      const rows = await dataSource.getRepository(OutboxEvent).find({
        where: { aggregateid: showId },
        order: { created_at: 'ASC', id: 'ASC' },
      });
      expect(rows.map((row) => row.type)).toEqual([
        'catalog.show.published.v1',
        'catalog.show.updated.v1',
      ]);
      expect(fromBinary(ShowUpdatedSchema, rows[1]?.payload ?? new Uint8Array()).tagIds).toEqual([
        'late-night',
      ]);

      const missing = await send('PATCH', '/shows/01a0e400-0000-7000-8000-0000000009ff', {
        tagIds: [],
      });
      expect(missing.statusCode).toBe(404);
    },
    CASE_MS,
  );

  it(
    'creates the channel’s face at version 1, replays it under its key, refuses a stale edit',
    async () => {
      const url = `/v1/channels/${CHANNEL}/identity`;
      const face = {
        expectedVersion: 0,
        publicName: 'Compagnie du Port',
        categoryId: 'theatre',
        biography: [{ contentLanguage: Locale.FR, text: 'Une compagnie.' }],
      };
      const key = '01a0e4ff-0000-7000-8000-000000000001';
      const created = await send('PATCH', url, face, key);
      expect(created.statusCode).toBe(200);
      expect(created.headers['cache-control']).toBe('no-store');
      expect(created.json()).toMatchObject({
        servedAt: NOW,
        version: 1,
        data: { publicName: 'Compagnie du Port', slug: 'compagnie-du-port' },
      });

      const replayed = await send('PATCH', url, face, key);
      expect(replayed.statusCode).toBe(200);
      expect(replayed.headers['idempotency-replayed']).toBe('true');
      expect(replayed.body).toBe(created.body);

      const stale = await send('PATCH', url, face, '01a0e4ff-0000-7000-8000-000000000002');
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({
        error: {
          code: DomainErrorCode.STATE_CONFLICT,
          nature: FailureNature.REFUSED,
          params: { version: 1 },
        },
      });
    },
    CASE_MS,
  );
});
