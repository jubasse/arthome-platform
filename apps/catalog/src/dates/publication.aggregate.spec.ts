import { describe, expect, it } from 'vitest';

import { DomainErrorCode, PublicationState, isDomainError } from '@arthome/core';

import { Publication } from './publication.aggregate.js';

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

describe('Publication', () => {
  it('counts one more change from the version the screen read', () => {
    const publication = scheduledAt(2);
    publication.advanceVersionFrom(2);
    expect(publication.snapshot.version).toBe(3);
  });

  it('refuses a screen that read another version, naming the current state and version', () => {
    const publication = scheduledAt(3);
    let refusal: unknown = null;
    try {
      publication.advanceVersionFrom(2);
    } catch (error) {
      refusal = error;
    }

    expect(isDomainError(refusal) && [refusal.code, refusal.params]).toEqual([
      DomainErrorCode.STATE_CONFLICT,
      { state: PublicationState.SCHEDULED, version: 3 },
    ]);
    expect(publication.snapshot.version).toBe(3);
  });
});
