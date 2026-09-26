import { PublicationState, ReplayPolicy, RightsScope } from '@arthome/core';

import type { PublicDate } from './date-card.js';

/** A date of "Nuit blanche", scheduled for 2026-11-04 at 19:30 UTC in Paris, 95 minutes. */
export function publicDate(overrides: Partial<PublicDate> = {}): PublicDate {
  return {
    date_id: '01a0e400-0000-7000-8000-000000000001',
    show_id: '01a0e400-0000-7000-8000-0000000000a1',
    channel_id: 'channel-1',
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
    canonical_url: 'https://arthome.test/fr/d/nuit-blanche-2026-11-04',
    slug_fr: 'nuit-blanche-2026-11-04',
    slug_en: 'white-night-2026-11-04',
    publication_state: PublicationState.SCHEDULED,
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
