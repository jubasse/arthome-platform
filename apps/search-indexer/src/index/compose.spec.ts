import { describe, expect, it } from 'vitest';

import {
  DateOutcome,
  PublicationState,
  ReplayPolicy,
  ReplayState,
  RightsScope,
} from '@arthome/core';

import { dateDocumentOf } from './compose.js';
import type { DateProjection, ScheduledDateFields } from '../consumer/date-projection.entity.js';

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
  canonical_url: 'https://arthome.test/show/nuit-blanche/date/2026-11-04',
  show_slug: 'nuit-blanche',
  slug: '2026-11-04',
};

function documentFor(
  fields: ScheduledDateFields,
  moved: Partial<
    Pick<
      DateProjection,
      | 'outcome'
      | 'outcome_rescheduled_to'
      | 'moved_starts_at'
      | 'moved_slug'
      | 'moved_canonical_url'
      | 'replay_state'
      | 'replay_live_ended_at'
      | 'replay_closes_at'
      | 'replay_online_at'
      | 'replay_duration_sec'
    >
  > = {},
) {
  return dateDocumentOf(
    {
      date_id: 'date-1',
      show_id: fields.show_id,
      scheduled: fields,
      scheduled_version: '1',
      publication_state: PublicationState.SCHEDULED,
      publication_version: null,
      outcome: null,
      outcome_rescheduled_to: null,
      outcome_version: null,
      moved_starts_at: null,
      moved_slug: null,
      moved_canonical_url: null,
      moved_version: null,
      replay_state: null,
      replay_live_ended_at: null,
      replay_closes_at: null,
      replay_online_at: null,
      replay_duration_sec: null,
      replay_version: null,
      doc_version: '1',
      indexed_at: new Date(),
      ...moved,
    },
    null,
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

describe('dateDocumentOf — a postponed date', () => {
  it('moves the date, and every instant a search compares moves with it', () => {
    const document = documentFor(scheduled, {
      outcome: DateOutcome.POSTPONED,
      outcome_rescheduled_to: new Date('2026-11-12T19:30:00.000Z'),
      moved_starts_at: new Date('2026-11-12T19:30:00.000Z'),
      moved_slug: '2026-11-12',
      moved_canonical_url: 'https://arthome.test/show/nuit-blanche/date/2026-11-12',
    });

    expect(document).toMatchObject({
      starts_at: '2026-11-12T19:30:00.000Z',
      show_slug: 'nuit-blanche',
      slug: '2026-11-12',
      canonical_url: 'https://arthome.test/show/nuit-blanche/date/2026-11-12',
      ends_at: '2026-11-12T21:05:00.000Z',
      over_at: '2026-11-15T21:05:00.000Z',
      outcome: DateOutcome.POSTPONED,
      rescheduled_to: '2026-11-12T19:30:00.000Z',
    });
  });

  describe('with the replay stated', () => {
    const liveEndedAt = new Date('2026-11-04T21:10:00.000Z');
    const closesAt = new Date('2026-11-07T21:10:00.000Z');
    const onlineAt = new Date('2026-11-05T09:00:00.000Z');
    const stated = {
      replay_live_ended_at: liveEndedAt,
      replay_closes_at: closesAt,
      replay_online_at: null,
      replay_duration_sec: null,
    };

    it('keeps a pending replay searchable until its real closing', () => {
      expect(
        documentFor(scheduled, { ...stated, replay_state: ReplayState.PENDING }),
      ).toMatchObject({
        over_at: closesAt.toISOString(),
        replay_state: ReplayState.PENDING,
        replay_closes_at: closesAt.toISOString(),
        replay_online_at: null,
        replay_duration_sec: null,
      });
    });

    it('carries the window and duration of an online replay, and bounds a closed one', () => {
      const online = { ...stated, replay_online_at: onlineAt, replay_duration_sec: 5400 };
      expect(documentFor(scheduled, { ...online, replay_state: ReplayState.ONLINE })).toMatchObject(
        {
          over_at: closesAt.toISOString(),
          replay_online_at: onlineAt.toISOString(),
          replay_duration_sec: 5400,
        },
      );
      expect(documentFor(scheduled, { ...online, replay_state: ReplayState.CLOSED })).toMatchObject(
        {
          over_at: closesAt.toISOString(),
          replay_state: ReplayState.CLOSED,
        },
      );
    });

    it('takes a withdrawn date out of search at the end of its live', () => {
      expect(
        documentFor(scheduled, { ...stated, replay_state: ReplayState.WITHDRAWN }),
      ).toMatchObject({
        over_at: liveEndedAt.toISOString(),
      });
    });

    it('keeps the scheduled bound while no replay fact has arrived', () => {
      expect(documentFor(scheduled, { ...stated, replay_state: null })).toMatchObject({
        over_at: '2026-11-07T21:05:00.000Z',
        replay_state: null,
      });
    });
  });
});
