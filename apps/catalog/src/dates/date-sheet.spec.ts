import { describe, expect, it } from 'vitest';

import {
  PublicationChecklistItem,
  PublicationPromise,
  PublicationState,
  Service,
} from '@arthome/core';

import { publicationView } from './date-sheet.js';
import type { Publication } from './publication.entity.js';

function publicationIn(state: PublicationState): Publication {
  return {
    date_id: 'date-1',
    channel_id: 'channel-1',
    state,
    version: 3,
    published_at: null,
    prices_locked_at: null,
    replay_online_at: null,
    updated_at: new Date(),
  };
}

describe('publicationView', () => {
  it('offers a draft its two transitions, the one-way one with its promise', () => {
    const view = publicationView(publicationIn(PublicationState.DRAFT), []);
    expect(view.offeredTransitions).toEqual([
      {
        from: PublicationState.DRAFT,
        to: PublicationState.RESERVE,
        irreversible: false,
        promiseCode: null,
      },
      {
        from: PublicationState.DRAFT,
        to: PublicationState.SCHEDULED,
        irreversible: true,
        promiseCode: PublicationPromise.PRICES_ENGAGED,
      },
    ]);
  });

  it('serves all nine checklist lines with their source, satisfied or not', () => {
    const view = publicationView(publicationIn(PublicationState.DRAFT), [
      PublicationChecklistItem.POSTER,
    ]);
    expect(view.checklist).toHaveLength(9);
    expect(view.checklist.find((line) => line.id === PublicationChecklistItem.POSTER)).toEqual({
      id: PublicationChecklistItem.POSTER,
      satisfied: true,
      source: Service.CATALOG,
      blocking: true,
    });
  });
});
