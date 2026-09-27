import type { EntityManager } from 'typeorm';
import { describe, expect, it } from 'vitest';

import {
  DateOutcome,
  Locale,
  PublicationState,
  ReplayPolicy,
  worldwideRights,
} from '@arthome/core';

import { PerformanceDateRow } from './performance-date.entity.js';
import { TypeOrmPerformanceDateRepository } from './performance-date.typeorm-repository.js';
import { PublicationRow } from './publication.entity.js';

const NOW = '2026-09-26T10:00:00.000Z';

const DATE: Omit<PerformanceDateRow, 'created_at' | 'updated_at'> = {
  id: 'date-1',
  show_id: 'show-1',
  venue_id: 'venue-1',
  channel_id: 'channel-1',
  starts_at: new Date('2026-11-04T19:30:00.000Z'),
  runtime_min: 95,
  replay_policy: ReplayPolicy.INCLUDED,
  replay_window_hours: 72,
  rights: worldwideRights(),
  slug: '2026-11-04',
  postponements: 0,
  outcome: null,
  rescheduled_to: null,
  outcome_declared_at: null,
  outcome_message: null,
};

const SCHEDULED: Omit<PublicationRow, 'updated_at'> = {
  date_id: 'date-1',
  channel_id: 'channel-1',
  state: PublicationState.SCHEDULED,
  version: 2,
  published_at: new Date(NOW),
  prices_locked_at: new Date(NOW),
  replay_online_at: null,
};

/** A repository over a manager that finds `DATE` and `SCHEDULED`, and records what it updates. */
function repositoryRecording(updated: unknown[]): TypeOrmPerformanceDateRepository {
  const manager = {
    findOne: () => Promise.resolve(SCHEDULED),
    findOneByOrFail: () => Promise.resolve(DATE),
    update: (entity: unknown) => {
      updated.push(entity);
      return Promise.resolve({ affected: 1 });
    },
  } as unknown as EntityManager;
  return new TypeOrmPerformanceDateRepository(manager, () => undefined);
}

describe('TypeOrmPerformanceDateRepository', () => {
  it('writes the publication alone when a command left the date as it was', async () => {
    const updated: unknown[] = [];
    const dates = repositoryRecording(updated);
    const date = await dates.findById('date-1');
    if (date === null) throw new Error('the fake manager always finds the date');
    date.transitionPublication(
      { to: PublicationState.TECHNICAL, expectedVersion: 2, acknowledgedPromise: null },
      { satisfied: [], freeSlug: null, showRuntimeMin: 95, now: NOW },
    );
    await dates.save(date);

    expect(updated).toEqual([PublicationRow]);
  });

  it('writes the publication, then the date, when the date changed', async () => {
    const updated: unknown[] = [];
    const dates = repositoryRecording(updated);
    const date = await dates.findById('date-1');
    if (date === null) throw new Error('the fake manager always finds the date');
    date.declareOutcome(
      2,
      { outcome: DateOutcome.CANCELLED, rescheduledTo: null },
      { contentLanguage: Locale.FR, text: 'Annulé.' },
      { slugAtNewStart: null, now: NOW },
    );
    await dates.save(date);

    expect(updated).toEqual([PublicationRow, PerformanceDateRow]);
  });
});
