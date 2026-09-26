import {
  DateScheduledSchema,
  PublicationState as WirePublicationState,
  PublicationStateChangedSchema,
  ReplayPolicy as WireReplayPolicy,
  RightsScope as WireRightsScope,
} from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';

import { PublicationState, ReplayPolicy, RightsScope } from '@arthome/core';

import { dateAfter, dateFactOf } from './date-consumer.js';
import type { DateProjection } from './date-projection.entity.js';

const DATE_ID = '01a0d537-0abe-71f1-9ee1-0000000000d1';

function scheduled(occurredAt: string): Uint8Array {
  return toBinary(
    DateScheduledSchema,
    create(DateScheduledSchema, {
      dateId: DATE_ID,
      showId: 'show-1',
      channelId: 'channel-1',
      venueId: 'venue-1',
      startsAt: timestampFromDate(new Date('2026-11-04T19:30:00.000Z')),
      venueClock: { venueTimezone: 'Europe/Paris', venueUtcOffsetMin: 60 },
      venueCity: 'Paris',
      venueCountry: 'FR',
      runtimeMin: 95,
      replayPolicy: WireReplayPolicy.INCLUDED,
      replayWindowHours: 72,
      rights: { scope: WireRightsScope.WORLDWIDE },
      canonicalUrl: 'https://arthome.test/fr/d/nuit-blanche-2026-11-04',
      slugFr: 'nuit-blanche-2026-11-04',
      slugEn: 'white-night-2026-11-04',
      occurredAt: timestampFromDate(new Date(occurredAt)),
    }),
  );
}

function stateChanged(to: WirePublicationState, version: number): Uint8Array {
  return toBinary(
    PublicationStateChangedSchema,
    create(PublicationStateChangedSchema, {
      dateId: DATE_ID,
      toState: to,
      version: BigInt(version),
    }),
  );
}

function emptyRow(): DateProjection {
  return {
    date_id: DATE_ID,
    show_id: null,
    scheduled: null,
    scheduled_version: null,
    publication_state: null,
    publication_version: null,
    doc_version: '0',
    indexed_at: new Date(),
  };
}

const SCHEDULED = 'catalog.date.scheduled.v1';
const STATE_CHANGED = 'catalog.publication.state_changed.v1';

describe('dateFactOf', () => {
  it('reads what DateScheduled makes public, in the domain’s vocabulary', () => {
    const fact = dateFactOf(SCHEDULED, scheduled('2026-09-26T10:00:00.000Z'));
    expect(fact).toMatchObject({
      type: SCHEDULED,
      fields: {
        starts_at: '2026-11-04T19:30:00.000Z',
        venue_timezone: 'Europe/Paris',
        venue_city: 'Paris',
        venue_country: 'FR',
        replay_policy: ReplayPolicy.INCLUDED,
        rights_scope: RightsScope.WORLDWIDE,
        slug_fr: 'nuit-blanche-2026-11-04',
        slug_en: 'white-night-2026-11-04',
      },
    });
  });

  it('versions a state change by the publication’s own version', () => {
    expect(dateFactOf(STATE_CHANGED, stateChanged(WirePublicationState.TECHNICAL, 4))).toEqual({
      type: STATE_CHANGED,
      dateId: DATE_ID,
      version: 4,
      state: PublicationState.TECHNICAL,
    });
  });
});

describe('dateAfter', () => {
  const schedule = dateFactOf(SCHEDULED, scheduled('2026-09-26T10:00:00.000Z'));
  const technical = dateFactOf(STATE_CHANGED, stateChanged(WirePublicationState.TECHNICAL, 4));

  it('makes a date public, scheduled, when DateScheduled lands first', () => {
    const next = dateAfter(emptyRow(), schedule);
    expect(next?.scheduled?.venue_city).toBe('Paris');
    expect(next?.publication_state).toBe(PublicationState.SCHEDULED);
  });

  it('keeps a later state that overtook DateScheduled', () => {
    const afterState = dateAfter(emptyRow(), technical);
    if (afterState === null) throw new Error('the state should apply');
    expect(afterState.scheduled).toBeNull();
    expect(dateAfter(afterState, schedule)?.publication_state).toBe(PublicationState.TECHNICAL);
  });

  it('refuses a state change older than the one it would replace', () => {
    const current = dateAfter(emptyRow(), technical);
    if (current === null) throw new Error('the state should apply');
    const older = dateFactOf(STATE_CHANGED, stateChanged(WirePublicationState.SCHEDULED, 3));
    expect(dateAfter(current, older)).toBeNull();
  });
});
