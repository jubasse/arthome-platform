import { describe, expect, it } from 'vitest';

import {
  DateOutcome,
  DomainErrorCode,
  Locale,
  PublicationChecklistItem,
  PublicationPromise,
  PublicationState,
  ReplayPolicy,
  isDomainError,
  worldwideRights,
} from '@arthome/core';

import { PerformanceDate, type PerformanceDateSnapshot } from './performance-date.aggregate.js';
import {
  DateDrafted,
  DateOutcomeDeclared,
  DateRescheduled,
  DateScheduled,
  PublicationEngaged,
  PublicationStateChanged,
} from './performance-date.events.js';
import type { PublicationSnapshot } from './publication.js';

const NOW = '2026-09-26T10:00:00.000Z';
const MESSAGE = { contentLanguage: Locale.FR, text: 'Report au 12 novembre.' };

const PUBLISHED: PerformanceDateSnapshot = {
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
};

const SCHEDULED_AT_2: PublicationSnapshot = {
  dateId: 'date-1',
  channelId: 'channel-1',
  state: PublicationState.SCHEDULED,
  version: 2,
  publishedAt: NOW,
  pricesLockedAt: NOW,
  replayOnlineAt: null,
};

const DRAFT_AT_1: PublicationSnapshot = {
  ...SCHEDULED_AT_2,
  state: PublicationState.DRAFT,
  version: 1,
  publishedAt: null,
  pricesLockedAt: null,
};

const EVERY_BLOCKING_ITEM = [
  PublicationChecklistItem.TITLE_AND_DISCIPLINE,
  PublicationChecklistItem.POSTER,
  PublicationChecklistItem.DESCRIPTION,
  PublicationChecklistItem.AT_LEAST_ONE_ACTIVE_PRICE,
  PublicationChecklistItem.CAPACITY,
  PublicationChecklistItem.TECHNICAL_CHECK_PASSED,
  PublicationChecklistItem.CHAT_MODE_SET,
];

const PUBLISH = {
  to: PublicationState.SCHEDULED,
  expectedVersion: 1,
  acknowledgedPromise: PublicationPromise.PRICES_ENGAGED,
};

function publishedDate(): PerformanceDate {
  return PerformanceDate.restore(PUBLISHED, SCHEDULED_AT_2);
}

function refusalOf(decide: () => unknown): unknown {
  try {
    decide();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

const scheduled = (slugAtNewStart: string | null = null) => ({ slugAtNewStart, now: NOW });

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

  it('goes public when published, under its free slug and its show’s running time now', () => {
    const date = PerformanceDate.restore({ ...PUBLISHED, slug: null }, DRAFT_AT_1);
    date.transitionPublication(PUBLISH, {
      satisfied: EVERY_BLOCKING_ITEM,
      freeSlug: '2026-11-04',
      showRuntimeMin: 110,
      now: NOW,
    });

    expect(date.snapshot).toMatchObject({ slug: '2026-11-04', runtimeMin: 110 });
    expect(date.publication).toMatchObject({ state: PublicationState.SCHEDULED, version: 2 });
    expect(date.getUncommittedEvents()).toEqual([
      new PublicationStateChanged(
        'date-1',
        'channel-1',
        PublicationState.DRAFT,
        PublicationState.SCHEDULED,
        2,
        true,
        NOW,
      ),
      new DateScheduled({ ...date.snapshot, slug: '2026-11-04' }, NOW),
      new PublicationEngaged('date-1', 'channel-1', NOW),
    ]);
  });

  it('stays private through a transition that does not publish', () => {
    const date = PerformanceDate.restore({ ...PUBLISHED, slug: null }, DRAFT_AT_1);
    date.transitionPublication(
      { to: PublicationState.RESERVE, expectedVersion: 1, acknowledgedPromise: null },
      { satisfied: [], freeSlug: '2026-11-04', showRuntimeMin: 110, now: NOW },
    );

    expect(date.snapshot).toMatchObject({ slug: null, runtimeMin: 95 });
    expect(date.publication).toMatchObject({ state: PublicationState.RESERVE, version: 2 });
    expect(date.getUncommittedEvents()).toHaveLength(1);
  });

  it('refuses to publish a date that already has a slug, and changes nothing', () => {
    const date = PerformanceDate.restore(PUBLISHED, DRAFT_AT_1);
    const refusal = refusalOf(() =>
      date.transitionPublication(PUBLISH, {
        satisfied: EVERY_BLOCKING_ITEM,
        freeSlug: null,
        showRuntimeMin: 95,
        now: NOW,
      }),
    );

    expect(isDomainError(refusal) && [refusal.code, refusal.params]).toEqual([
      DomainErrorCode.STATE_CONFLICT,
      { slug: '2026-11-04' },
    ]);
    expect(date.snapshot).toBe(PUBLISHED);
    expect(date.publication).toBe(DRAFT_AT_1);
    expect(date.getUncommittedEvents()).toEqual([]);
  });

  it('moves a postponed date, its start and its slug, and records the outcome then the move', () => {
    const date = publishedDate();
    date.declareOutcome(
      2,
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
    expect(date.publication.version).toBe(3);
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
      2,
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
        2,
        { outcome: DateOutcome.INTERRUPTED, rescheduledTo: null },
        MESSAGE,
        scheduled(),
      );
    } catch (error) {
      refusal = error;
    }

    expect(isDomainError(refusal) && refusal.code).toBe(DomainErrorCode.STATE_CONFLICT);
    expect(date.snapshot).toBe(before);
    expect(date.publication).toBe(SCHEDULED_AT_2);
    expect(date.getUncommittedEvents()).toEqual([]);
  });

  it('refuses an outcome from a screen that read another version, naming the current one', () => {
    const date = publishedDate();
    const refusal = refusalOf(() =>
      date.declareOutcome(
        1,
        { outcome: DateOutcome.CANCELLED, rescheduledTo: null },
        MESSAGE,
        scheduled(),
      ),
    );

    expect(isDomainError(refusal) && [refusal.code, refusal.params]).toEqual([
      DomainErrorCode.STATE_CONFLICT,
      { state: PublicationState.SCHEDULED, version: 2 },
    ]);
    expect(date.getUncommittedEvents()).toEqual([]);
  });
});
