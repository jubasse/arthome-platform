import { CqrsModule, QueryBus, type Query } from '@nestjs/cqrs';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { PublicationState, ReplayPolicy, RightsScope, type Clock } from '@arthome/core';

import type { PublicDate } from './date-card.js';
import { GetArtistDetailHandler } from './get-artist-detail.handler.js';
import { GetDateDetailHandler } from './get-date-detail.handler.js';
import { ResolvePublicLinkHandler } from './resolve-public-link.handler.js';
import { CLOCK } from '../clock.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/** A date of "Nuit blanche", scheduled for 2026-11-04 at 19:30 UTC in Paris, 95 minutes. */
export function publicDate(overrides: Partial<PublicDate> = {}): PublicDate {
  return {
    date_id: '01a0e400-0000-7000-8000-000000000001',
    show_id: '01a0e400-0000-7000-8000-0000000000a1',
    channel_id: 'channel-1',
    artist_id: null,
    artist_name: null,
    venue_id: '01a0e400-0000-7000-8000-0000000000c1',
    venue_city: 'Paris',
    venue_country: 'FR',
    venue_timezone: 'Europe/Paris',
    starts_at: '2026-11-04T19:30:00.000Z',
    runtime_min: 95,
    replay_policy: ReplayPolicy.INCLUDED,
    replay_window_hours: 72,
    rights_scope: RightsScope.WORLDWIDE,
    blackout_countries: [],
    canonical_url: 'https://arthome.test/show/nuit-blanche/date/2026-11-04',
    show_slug: 'nuit-blanche',
    slug: '2026-11-04',
    publication_state: PublicationState.SCHEDULED,
    outcome: null,
    rescheduled_to: null,
    category_id: 'theatre',
    genre_ids: ['contemporary'],
    tag_ids: [],
    language_dependency: null,
    title_fr: 'Nuit blanche',
    title_en: 'White night',
    media: {
      wide: [{ url: 'https://cdn.arthome.test/w.jpg', widthPx: 1280, heightPx: 720 }],
      poster: [],
    },
    ...overrides,
  };
}

/**
 * A real `QueryBus` holding the public read handlers, at `clock`'s time. Each `execute` boots and
 *   closes its own module, so a suite builds one per instant with nothing left to close.
 */
export function publicQueryBus(
  dataSource: DataSource,
  clock: Clock,
  origin: string,
): { execute<R>(query: Query<R>): Promise<R> } {
  return {
    async execute<R>(query: Query<R>): Promise<R> {
      const moduleRef = await Test.createTestingModule({
        imports: [CqrsModule.forRoot()],
        providers: [
          GetDateDetailHandler,
          GetArtistDetailHandler,
          ResolvePublicLinkHandler,
          { provide: DataSource, useValue: dataSource },
          { provide: CLOCK, useValue: clock },
          { provide: PUBLIC_WEB_ORIGIN, useValue: origin },
        ],
      }).compile();
      // Handlers register with the buses when the module initialises.
      await moduleRef.init();
      try {
        return await moduleRef.get(QueryBus).execute(query);
      } finally {
        await moduleRef.close();
      }
    },
  };
}
