import { describe, expect, it } from 'vitest';

import {
  DateOutcome,
  DomainErrorCode,
  Locale,
  PublicationState,
  ReplayPolicy,
  isDomainError,
  worldwideRights,
} from '@arthome/core';

import { PerformanceDate } from './performance-date.aggregate.js';
import {
  DateDrafted,
  DateOutcomeDeclared,
  DateRescheduled,
  DateScheduled,
} from './performance-date.events.js';

const NOW = '2026-09-26T10:00:00.000Z';
const MESSAGE = { contentLanguage: Locale.FR, text: 'Report au 12 novembre.' };

function publishedDate(): PerformanceDate {
  return PerformanceDate.restore({
    id: 'date-1',
    showId: 'show-1',
    venueId: 'venue-1',
    channelId: 'channel-1',
    startsAt: '2026-11-04T19:30:00.000Z',
    runtimeMin: 95,
    replayPolicy: ReplayPolicy.INCLUDED,
    replayWindowHours: 72,
    rights: worldwideRights(),
    slug: '2026-11-04',
    postponements: 0,
    outcome: null,
    rescheduledTo: null,
    outcomeDeclaredAt: null,
    outcomeMessage: null,
  });
}

const scheduled = (slugAtNewStart: string | null = null) => ({
  publicationState: PublicationState.SCHEDULED,
  slugAtNewStart,
  now: NOW,
});

describe('PerformanceDate', () => {
  it('drafts a date worldwide and without a slug, and says so', () => {
    const date = PerformanceDate.draft(
      {
        id: 'date-1',
        showId: 'show-1',
        venueId: 'venue-1',
        channelId: 'channel-1',
        startsAt: '2026-11-04T19:30:00.000Z',
        runtimeMin: 95,
        replayPolicy: ReplayPolicy.NONE,
        replayWindowHours: null,
      },
      NOW,
    );

    expect(date.snapshot).toMatchObject({
      rights: worldwideRights(),
      slug: null,
      postponements: 0,
      outcome: null,
    });
    expect(date.getUncommittedEvents()).toEqual([
      new DateDrafted('date-1', 'channel-1', 'show-1', 'venue-1', NOW),
    ]);
  });

  it('goes public under its slug, with the running time its show has now', () => {
    const date = PerformanceDate.restore({ ...publishedDate().snapshot, slug: null });
    date.makePublic('2026-11-04', 110, NOW);

    expect(date.snapshot).toMatchObject({ slug: '2026-11-04', runtimeMin: 110 });
    expect(date.getUncommittedEvents()).toEqual([
      new DateScheduled({ ...date.snapshot, slug: '2026-11-04' }, NOW),
    ]);
  });

  it('moves a postponed date, its start and its slug, and records the outcome then the move', () => {
    const date = publishedDate();
    date.declareOutcome(
      { outcome: DateOutcome.POSTPONED, rescheduledTo: '2026-11-12T19:30:00.000Z' },
      MESSAGE,
      scheduled('2026-11-12'),
    );

    expect(date.snapshot).toMatchObject({
      outcome: DateOutcome.POSTPONED,
      startsAt: '2026-11-12T19:30:00.000Z',
      rescheduledTo: '2026-11-12T19:30:00.000Z',
      slug: '2026-11-12',
      postponements: 1,
      outcomeDeclaredAt: NOW,
      outcomeMessage: MESSAGE,
    });
    expect(date.getUncommittedEvents()).toEqual([
      new DateOutcomeDeclared(
        'date-1',
        'channel-1',
        DateOutcome.POSTPONED,
        MESSAGE,
        '2026-11-12T19:30:00.000Z',
        NOW,
      ),
      new DateRescheduled(
        'date-1',
        'show-1',
        '2026-11-04T19:30:00.000Z',
        '2026-11-12T19:30:00.000Z',
        '2026-11-04',
        '2026-11-12',
        NOW,
      ),
    ]);
  });

  it('cancels a date where it stands, with one event', () => {
    const date = publishedDate();
    date.declareOutcome(
      { outcome: DateOutcome.CANCELLED, rescheduledTo: null },
      MESSAGE,
      scheduled(),
    );

    expect(date.snapshot).toMatchObject({
      outcome: DateOutcome.CANCELLED,
      startsAt: '2026-11-04T19:30:00.000Z',
      rescheduledTo: null,
      slug: '2026-11-04',
      postponements: 0,
    });
    expect(date.getUncommittedEvents()).toHaveLength(1);
  });

  it('refuses what core refuses, and changes nothing', () => {
    const date = publishedDate();
    const before = date.snapshot;

    let refusal: unknown = null;
    try {
      date.declareOutcome(
        { outcome: DateOutcome.INTERRUPTED, rescheduledTo: null },
        MESSAGE,
        scheduled(),
      );
    } catch (error) {
      refusal = error;
    }

    expect(isDomainError(refusal) && refusal.code).toBe(DomainErrorCode.STATE_CONFLICT);
    expect(date.snapshot).toBe(before);
    expect(date.getUncommittedEvents()).toEqual([]);
  });
});
