import { describe, expect, it } from 'vitest';

import {
  DomainErrorCode,
  PublicationChecklistItem,
  PublicationPromise,
  PublicationState,
  isDomainError,
} from '@arthome/core';

import { PublicationEngaged, PublicationStateChanged } from './performance-date.events.js';
import { Publication } from './publication.js';

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
    const publication = scheduledAt(2).advancedFrom(2);
    expect(publication.snapshot.version).toBe(3);
  });

  it('refuses a screen that read another version, naming the current state and version', () => {
    const publication = scheduledAt(3);
    const refusal = refusalOf(() => publication.advancedFrom(2));

    expect(isDomainError(refusal) && [refusal.code, refusal.params]).toEqual([
      DomainErrorCode.STATE_CONFLICT,
      { currentVersion: 3, state: PublicationState.SCHEDULED },
    ]);
    expect(publication.snapshot.version).toBe(3);
  });

  it('moves a draft into reserve without publishing it', () => {
    const { publication, changed, engaged } = Publication.draft('date-1', 'channel-1').transitioned(
      { to: PublicationState.RESERVE, expectedVersion: 1, acknowledgedPromise: null },
      [],
      NOW,
    );

    expect(engaged).toBeNull();
    expect(publication.snapshot).toMatchObject({
      state: PublicationState.RESERVE,
      version: 2,
      publishedAt: null,
    });
    expect(changed).toEqual(
      new PublicationStateChanged(
        'date-1',
        'channel-1',
        PublicationState.DRAFT,
        PublicationState.RESERVE,
        2,
        false,
        NOW,
      ),
    );
  });

  it('refuses to publish while a blocking item is missing, naming them, and changes nothing', () => {
    const publication = Publication.draft('date-1', 'channel-1');
    const before = publication.snapshot;
    const refusal = refusalOf(() =>
      publication.transitioned(
        {
          to: PublicationState.SCHEDULED,
          expectedVersion: 1,
          acknowledgedPromise: PublicationPromise.PRICES_ENGAGED,
        },
        [PublicationChecklistItem.POSTER],
        NOW,
      ),
    );

    expect(isDomainError(refusal) && refusal.code).toBe(
      DomainErrorCode.PUBLICATION_CHECKLIST_INCOMPLETE,
    );
    expect(isDomainError(refusal) && refusal.params).toMatchObject({
      missing: expect.arrayContaining([PublicationChecklistItem.CAPACITY]) as unknown,
    });
    expect(publication.snapshot).toBe(before);
  });

  it('publishes a complete draft: the prices locked, then what it engaged', () => {
    const { publication, changed, engaged } = Publication.draft('date-1', 'channel-1').transitioned(
      {
        to: PublicationState.SCHEDULED,
        expectedVersion: 1,
        acknowledgedPromise: PublicationPromise.PRICES_ENGAGED,
      },
      EVERY_BLOCKING_ITEM,
      NOW,
    );

    expect(publication.snapshot).toMatchObject({
      state: PublicationState.SCHEDULED,
      version: 2,
      publishedAt: NOW,
      pricesLockedAt: NOW,
    });
    expect([changed, engaged]).toEqual([
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
    const { publication, engaged } = Publication.restore({
      ...scheduledAt(3).snapshot,
      state: PublicationState.TECHNICAL,
    }).transitioned(
      { to: PublicationState.SCHEDULED, expectedVersion: 3, acknowledgedPromise: null },
      [],
      '2026-09-27T10:00:00.000Z',
    );

    expect(engaged).toBeNull();
    expect(publication.snapshot.publishedAt).toBe('2026-09-26T10:00:00.000Z');
  });
});
