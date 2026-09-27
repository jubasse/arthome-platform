import { ArtistUpdatedSchema } from '@arthome-platform/events';
import { RefusalException, type IdempotentRequest } from '@arthome-platform/http-edge';
import { OutboxEvent } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ApiErrorCode,
  CatalogErrorCode,
  DomainErrorCode,
  FixedClock,
  LanguageDependency,
  Locale,
  PublicationState,
  ReplayPolicy,
  worldwideRights,
} from '@arthome/core';

import { UpdateChannelIdentity } from './update-channel-identity.command.js';
import { UpdateChannelIdentityHandler } from './update-channel-identity.handler.js';
import type { UpdateIdentityBody } from './update-identity.schema.js';
import { CatalogTransactions } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { publicQueryBus } from '../itest/public-query-bus.js';
import { CATALOG_SCHEMA } from '../itest/schema.js';
import { DateDetailPublic } from '../public/date-detail-public.entity.js';
import { ResolvePublicLink } from '../public/resolve-public-link.query.js';

/** The channel's public face against a real Postgres: versions, slugs and what it projects. */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

let stack: StartedStack;
let dataSource: DataSource;
let cqrs: TestingModule;
let commands: CommandBus;
let keys = 0;

function edit(channelId: string, body: UpdateIdentityBody) {
  keys += 1;
  const key: IdempotentRequest = {
    key: `01a0e8ff-0000-7000-8000-${String(keys).padStart(12, '0')}`,
    accountId: null,
    fingerprint: `${channelId}:${keys}`,
    statusCode: 200,
  };
  return commands.execute(new UpdateChannelIdentity(channelId, body, null, key));
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

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'catalog_artists_itest');
  dataSource = await applyMigrations(database, CATALOG_SCHEMA);
  cqrs = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      CatalogTransactions,
      UpdateChannelIdentityHandler,
      { provide: DataSource, useValue: dataSource },
      { provide: CLOCK, useValue: new FixedClock('2026-09-27T10:00:00.000Z') },
    ],
  }).compile();
  // Handlers register with the bus when the module initialises.
  await cqrs.init();
  commands = cqrs.get(CommandBus);
}, STARTUP_MS);

afterAll(async () => {
  await cqrs?.close();
  await dataSource?.destroy();
  await stack?.stop();
});

describe('a channel’s public face', () => {
  it(
    'is created at version 1 from version 0, with a slug from its name, and announced',
    async () => {
      const response = await edit('channel-a', {
        expectedVersion: 0,
        publicName: 'Compagnie Verticale',
        categoryId: 'dance-contemporary',
        biography: [{ contentLanguage: Locale.FR, text: 'Une compagnie de danse.' }],
      });

      expect(response.envelope).toMatchObject({
        version: 1,
        data: { publicName: 'Compagnie Verticale', slug: 'compagnie-verticale' },
      });
      const rows = await dataSource.getRepository(OutboxEvent).findBy({
        type: 'catalog.artist.updated.v1',
      });
      expect(rows.map((row) => [row.aggregatetype, row.aggregateid])).toEqual([
        ['catalog.artist', response.envelope.data.artistId],
      ]);
      const event = fromBinary(ArtistUpdatedSchema, rows[0]?.payload ?? new Uint8Array());
      expect(event).toMatchObject({
        channelId: 'channel-a',
        publicName: 'Compagnie Verticale',
        slug: 'compagnie-verticale',
        biography: [{ contentLanguage: Locale.FR, text: 'Une compagnie de danse.' }],
      });
    },
    CASE_MS,
  );

  it(
    'refuses an edit from a stale version, and one creating without a name',
    async () => {
      const stale = await refusalOf(edit('channel-a', { expectedVersion: 0, publicName: 'Autre' }));
      expect(stale.refusal).toMatchObject({
        code: DomainErrorCode.STATE_CONFLICT,
        params: { version: 1 },
      });

      const nameless = await refusalOf(edit('channel-b', { expectedVersion: 0 }));
      expect(nameless.refusal).toMatchObject({
        code: ApiErrorCode.SCHEMA_INVALID,
        params: { fields: ['categoryId', 'publicName'] },
      });
    },
    CASE_MS,
  );

  it(
    'refuses a slug another artist holds, and derives another when the name collides',
    async () => {
      const taken = await refusalOf(
        edit('channel-b', {
          expectedVersion: 0,
          publicName: 'Ensemble Nuit',
          categoryId: 'music',
          slug: 'compagnie-verticale',
        }),
      );
      expect(taken.refusal.code).toBe(CatalogErrorCode.ARTIST_SLUG_TAKEN);

      const namesake = await edit('channel-b', {
        expectedVersion: 0,
        publicName: 'Compagnie Verticale',
        categoryId: 'music',
      });
      expect(namesake.envelope.data.slug).toMatch(/^compagnie-verticale-[0-9a-f]{8}$/);
    },
    CASE_MS,
  );

  it(
    'renames the artist on every public date of its channel',
    async () => {
      await dataSource.getRepository(DateDetailPublic).insert({
        date_id: '01a0e800-0000-7000-8000-000000000001',
        show_id: '01a0e800-0000-7000-8000-0000000000a1',
        channel_id: 'channel-a',
        venue_id: '01a0e800-0000-7000-8000-0000000000c1',
        venue_name: 'Théâtre',
        venue_city: 'Paris',
        venue_country: 'FR',
        venue_timezone: 'Europe/Paris',
        starts_at: new Date('2026-11-04T19:30:00.000Z'),
        runtime_min: 95,
        replay_policy: ReplayPolicy.NONE,
        replay_window_hours: 0,
        rights: worldwideRights(),
        show_slug: 'nuit-blanche',
        slug: '2026-11-04',
        publication_state: PublicationState.SCHEDULED,
        outcome: null,
        rescheduled_to: null,
        artist_id: 'show-named-artist',
        artist_name: null,
        category_id: 'dance-contemporary',
        genre_ids: [],
        tag_ids: [],
        language_dependency: LanguageDependency.NONE,
        spoken_languages: [],
        subtitle_languages: [],
        surtitle_languages: [],
        media: { wide: [], poster: [] },
        title: { fr: 'Nuit blanche', en: '' },
        synopsis: { fr: '', en: '' },
      });

      const renamed = await edit('channel-a', { expectedVersion: 1, publicName: 'Verticale' });
      const row = await dataSource
        .getRepository(DateDetailPublic)
        .findOneByOrFail({ date_id: '01a0e800-0000-7000-8000-000000000001' });

      expect(renamed.envelope.version).toBe(2);
      expect(row).toMatchObject({
        artist_id: renamed.envelope.data.artistId,
        artist_name: 'Verticale',
      });
    },
    CASE_MS,
  );

  it(
    'keeps a replaced slug leading to the artist, for the artist alone to take back (D-075)',
    async () => {
      const moved = await edit('channel-a', { expectedVersion: 2, slug: 'verticale' });
      expect(moved.envelope.data.slug).toBe('verticale');

      const links = publicQueryBus(
        dataSource,
        new FixedClock('2026-09-27T10:00:00.000Z'),
        'https://arthome.test',
      );
      expect(
        (
          await links.execute(
            new ResolvePublicLink({ url: 'https://arthome.test/a/compagnie-verticale' }),
          )
        ).data,
      ).toMatchObject({
        id: moved.envelope.data.artistId,
        canonicalUrl: 'https://arthome.test/artist/verticale',
      });

      const squatter = await refusalOf(
        edit('channel-c', {
          expectedVersion: 0,
          publicName: 'Troupe',
          categoryId: 'theatre',
          slug: 'compagnie-verticale',
        }),
      );
      expect(squatter.refusal.code).toBe(CatalogErrorCode.ARTIST_SLUG_TAKEN);

      const back = await edit('channel-a', { expectedVersion: 3, slug: 'compagnie-verticale' });
      expect(back.envelope.data.slug).toBe('compagnie-verticale');
    },
    CASE_MS,
  );
});
