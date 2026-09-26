import { describe, expect, it } from 'vitest';

import { PublicationState, ReplayPolicy, RightsScope } from '@arthome/core';

import { dateDocumentOf } from './compose.js';
import type { ScheduledDateFields } from '../consumer/date-projection.entity.js';

const scheduled: ScheduledDateFields = {
  show_id: 'show-1',
  channel_id: 'channel-1',
  venue_id: 'venue-1',
  starts_at: '2026-11-04T19:30:00.000Z',
  venue_timezone: 'Europe/Paris',
  venue_city: 'Paris',
  venue_country: 'FR',
  runtime_min: 95,
  replay_policy: ReplayPolicy.INCLUDED,
  replay_window_hours: 72,
  rights_scope: RightsScope.WORLDWIDE,
  blackout_countries: [],
  canonical_url: 'https://arthome.test/fr/d/nuit-blanche-2026-11-04',
  slug_fr: 'nuit-blanche-2026-11-04',
  slug_en: 'white-night-2026-11-04',
};

function documentFor(fields: ScheduledDateFields) {
  return dateDocumentOf(
    {
      date_id: 'date-1',
      show_id: fields.show_id,
      scheduled: fields,
      scheduled_version: '1',
      publication_state: PublicationState.SCHEDULED,
      publication_version: null,
      doc_version: '1',
      indexed_at: new Date(),
    },
    null,
    new Date('2026-09-26T10:00:00.000Z'),
  );
}

describe('dateDocumentOf — the instants a search compares', () => {
  it('ends the date with its replay window', () => {
    expect(documentFor(scheduled)).toMatchObject({
      ends_at: '2026-11-04T21:05:00.000Z',
      over_at: '2026-11-07T21:05:00.000Z',
    });
  });

  it('ends it with the live show when no replay is promised, or the policy is unknown', () => {
    for (const replay_policy of [ReplayPolicy.NONE, null]) {
      expect(documentFor({ ...scheduled, replay_policy })).toMatchObject({
        ends_at: '2026-11-04T21:05:00.000Z',
        over_at: '2026-11-04T21:05:00.000Z',
      });
    }
  });
});
