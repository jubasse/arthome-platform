import { ShowUpdatedSchema } from '@arthome-platform/events';
import { OutboxEvent } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  httpApp,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ApiErrorCode,
  DomainErrorCode,
  FailureNature,
  FixedClock,
  LanguageDependency,
  Locale,
  Service,
} from '@arthome/core';

import { CatalogModule } from './catalog.module.js';
import { Show } from './show.entity.js';
import { ArtistsModule } from '../artists/artists.module.js';
import { CLOCK } from '../clock.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { untilBlockedOrSettled } from '../itest/lock-waits.js';
import { CATALOG_SCHEMA } from '../itest/schema.js';
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
  dataSource = await applyMigrations(database, CATALOG_SCHEMA);

  app = await httpApp({
    imports: [CatalogModule, VenuesModule, ArtistsModule],
    providers: EDGE_PROVIDERS,
    caller: { service: Service.CATALOG, clock: new FixedClock(NOW) },
    dataSource,
    overrides: [[CLOCK, new FixedClock(NOW)]],
  });
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
    'answers 409 to a show whose slug another took at the same moment, and slugs its retry anew',
    async () => {
      const title = { fr: 'Course contre la montre', en: '' };
      const show = {
        channelId: CHANNEL,
        artistId: 'artist-studio-http',
        categoryId: 'theatre',
        genreIds: [],
        tagIds: [],
        runtimeMin: 80,
        languageDependency: LanguageDependency.NONE,
        spokenLanguages: ['fr-FR'],
        subtitleLanguages: [],
        surtitleLanguages: [],
        media: {
          wide: [],
          poster: [{ url: 'https://cdn.example.test/p.jpg', widthPx: 480, heightPx: 720 }],
        },
        title,
      };
      // Another publication of the same title, inserted and not yet committed: the slug looks free.
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      let publishing: ReturnType<typeof send> | undefined;
      try {
        await runner.manager.insert(Show, {
          id: '01a0e400-0000-7000-8000-0000000000f1',
          slug: 'course-contre-la-montre',
          channel_id: CHANNEL,
          artist_id: 'artist-studio-http',
          category_id: 'theatre',
          genre_ids: [],
          tag_ids: [],
          runtime_min: 80,
          language_dependency: LanguageDependency.NONE,
          spoken_languages: ['fr-FR'],
          subtitle_languages: [],
          surtitle_languages: [],
          media: { wide: [], poster: [] },
          title,
          synopsis: { fr: '', en: '' },
        });
        publishing = send('POST', '/shows', show);
        await untilBlockedOrSettled(dataSource, publishing);
        await runner.commitTransaction();
      } finally {
        await runner.release();
      }

      const lost = await publishing;
      expect(lost?.statusCode).toBe(409);
      expect(lost?.json()).toMatchObject({
        error: { code: DomainErrorCode.STATE_CONFLICT, nature: FailureNature.REFUSED },
      });

      const retried = await send('POST', '/shows', show);
      expect(retried.statusCode).toBe(201);
      const { showId } = retried.json<{ data: { showId: string } }>().data;
      const { slug } = await dataSource.getRepository(Show).findOneByOrFail({ id: showId });
      expect(slug).toMatch(/^course-contre-la-montre-[0-9a-f]{8}$/);
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
