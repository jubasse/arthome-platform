import { describe, expect, it } from 'vitest';

import {
  DomainErrorCode,
  PublicationChecklistItem,
  PublicationPromise,
  PublicationState,
  isDomainError,
} from '@arthome/core';

import { Publication, PublicationChecklistIncomplete } from './publication.aggregate.js';
import { PublicationEngaged, PublicationStateChanged } from './publication.events.js';

const NOW = '2026-09-26T10:00:00.000Z';

const EVERY_BLOCKING_ITEM = [
  PublicationChecklistItem.TITLE_AND_DISCIPLINE,
  PublicationChecklistItem.POSTER,
  PublicationChecklistItem.DESCRIPTION,
  PublicationChecklistItem.AT_LEAST_ONE_ACTIVE_PRICE,
  PublicationChecklistItem.CAPACITY,
  PublicationChecklistItem.TECHNICAL_CHECK_PASSED,
  PublicationChecklistItem.CHAT_MODE_SET,
];

function scheduledAt(version: number): Publication {
  return Publication.restore({
    dateId: 'date-1',
    channelId: 'channel-1',
    state: PublicationState.SCHEDULED,
    version,
    publishedAt: '2026-09-26T10:00:00.000Z',
    pricesLockedAt: '2026-09-26T10:00:00.000Z',
    replayOnlineAt: null,
  });
}

function refusalOf(decide: () => unknown): unknown {
  try {
    decide();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

describe('Publication', () => {
  it('counts one more change from the version the screen read', () => {
    const publication = scheduledAt(2);
    publication.advanceVersionFrom(2);
    expect(publication.snapshot.version).toBe(3);
  });

  it('refuses a screen that read another version, naming the current state and version', () => {
    const publication = scheduledAt(3);
    const refusal = refusalOf(() => publication.advanceVersionFrom(2));

    expect(isDomainError(refusal) && [refusal.code, refusal.params]).toEqual([
      DomainErrorCode.STATE_CONFLICT,
      { state: PublicationState.SCHEDULED, version: 3 },
    ]);
    expect(publication.snapshot.version).toBe(3);
  });

  it('moves a draft into reserve without publishing it', () => {
    const publication = Publication.draft('date-1', 'channel-1');
    const published = publication.transition(
      { to: PublicationState.RESERVE, expectedVersion: 1, acknowledgedPromise: null },
      { satisfied: [], now: NOW },
    );

    expect(published).toBe(false);
    expect(publication.snapshot).toMatchObject({
      state: PublicationState.RESERVE,
      version: 2,
      publishedAt: null,
    });
    expect(publication.getUncommittedEvents()).toEqual([
      new PublicationStateChanged(
        'date-1',
        'channel-1',
        PublicationState.DRAFT,
        PublicationState.RESERVE,
        2,
        false,
        NOW,
      ),
    ]);
  });

  it('refuses to publish while a blocking item is missing, naming them, and changes nothing', () => {
    const publication = Publication.draft('date-1', 'channel-1');
    const before = publication.snapshot;
    const refusal = refusalOf(() =>
      publication.transition(
        {
          to: PublicationState.SCHEDULED,
          expectedVersion: 1,
          acknowledgedPromise: PublicationPromise.PRICES_ENGAGED,
        },
        { satisfied: [PublicationChecklistItem.POSTER], now: NOW },
      ),
    );

    expect(refusal).toBeInstanceOf(PublicationChecklistIncomplete);
    expect(isDomainError(refusal) && refusal.code).toBe(
      DomainErrorCode.PUBLICATION_CHECKLIST_INCOMPLETE,
    );
    expect((refusal as PublicationChecklistIncomplete).missing).toContain(
      PublicationChecklistItem.CAPACITY,
    );
    expect(publication.snapshot).toBe(before);
    expect(publication.getUncommittedEvents()).toEqual([]);
  });

  it('publishes a complete draft: the prices locked, then what it engaged', () => {
    const publication = Publication.draft('date-1', 'channel-1');
    const published = publication.transition(
      {
        to: PublicationState.SCHEDULED,
        expectedVersion: 1,
        acknowledgedPromise: PublicationPromise.PRICES_ENGAGED,
      },
      { satisfied: EVERY_BLOCKING_ITEM, now: NOW },
    );

    expect(published).toBe(true);
    expect(publication.snapshot).toMatchObject({
      state: PublicationState.SCHEDULED,
      version: 2,
      publishedAt: NOW,
      pricesLockedAt: NOW,
    });
    expect(publication.getUncommittedEvents()).toEqual([
      new PublicationStateChanged(
        'date-1',
        'channel-1',
        PublicationState.DRAFT,
        PublicationState.SCHEDULED,
        2,
        true,
        NOW,
      ),
      new PublicationEngaged('date-1', 'channel-1', NOW),
    ]);
  });

  it('does not publish again on the way back from technical, checklist or not', () => {
    const publication = Publication.restore({
      ...scheduledAt(3).snapshot,
      state: PublicationState.TECHNICAL,
    });
    const published = publication.transition(
      { to: PublicationState.SCHEDULED, expectedVersion: 3, acknowledgedPromise: null },
      { satisfied: [], now: '2026-09-27T10:00:00.000Z' },
    );

    expect(published).toBe(false);
    expect(publication.snapshot.publishedAt).toBe('2026-09-26T10:00:00.000Z');
    expect(publication.getUncommittedEvents()).toHaveLength(1);
  });
});
