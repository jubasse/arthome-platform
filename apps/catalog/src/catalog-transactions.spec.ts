import { EventPublisher, type EventBus, type IEvent } from '@nestjs/cqrs';
import type { DataSource, EntityManager } from 'typeorm';
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

import { CatalogTransactions, type CatalogTransaction } from './catalog-transactions.js';
import type { PerformanceDateRow } from './dates/performance-date.entity.js';
import { DateOutcomeDeclared } from './dates/performance-date.events.js';
import { PublicationRow } from './dates/publication.entity.js';

const ROW: Omit<PerformanceDateRow, 'created_at' | 'updated_at'> = {
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

const PUBLICATION: Omit<PublicationRow, 'updated_at'> = {
  date_id: 'date-1',
  channel_id: 'channel-1',
  state: PublicationState.SCHEDULED,
  version: 2,
  published_at: new Date('2026-09-26T10:00:00.000Z'),
  prices_locked_at: new Date('2026-09-26T10:00:00.000Z'),
  replay_online_at: null,
};

/** `affected` is what the version-conditional UPDATE matches: 0 once another command committed. */
function managerMatching(affected: number): EntityManager {
  return {
    findOne: () => Promise.resolve(PUBLICATION),
    // The date's row at load; the publication's re-read after a refused save.
    findOneByOrFail: (entity: unknown) =>
      Promise.resolve(entity === PublicationRow ? { ...PUBLICATION, version: 3 } : ROW),
    update: () => Promise.resolve({ affected }),
  } as unknown as EntityManager;
}

/** `settle` is what the database does once the work has resolved: commit, or fail to. */
function transactions(
  delivered: IEvent[],
  settle: () => Promise<void>,
  manager = managerMatching(1),
): CatalogTransactions {
  const dataSource = {
    transaction: async (work: (m: EntityManager) => Promise<unknown>) => {
      const result = await work(manager);
      await settle();
      return result;
    },
  } as unknown as DataSource;
  // `commit()` empties the array it hands over, so it is copied as it arrives.
  const bus = {
    publishAll: (events: IEvent[]) => delivered.push(...events),
  } as unknown as EventBus;
  return new CatalogTransactions(dataSource, new EventPublisher(bus));
}

async function cancelAndSave({ dates }: CatalogTransaction): Promise<void> {
  const date = await dates.findById('date-1');
  if (date === null) throw new Error('the fake manager always finds the date');
  date.declareOutcome(
    2,
    { outcome: DateOutcome.CANCELLED, rescheduledTo: null },
    { contentLanguage: Locale.FR, text: 'Annulé.' },
    { slugAtNewStart: null, now: '2026-09-26T10:00:00.000Z' },
  );
  await dates.save(date);
}

describe('CatalogTransactions', () => {
  it('publishes a saved aggregate’s events once the transaction has committed', async () => {
    const delivered: IEvent[] = [];
    await transactions(delivered, () => Promise.resolve()).run(cancelAndSave);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toBeInstanceOf(DateOutcomeDeclared);
  });

  it('publishes nothing when the work fails after the save', async () => {
    const delivered: IEvent[] = [];
    const run = transactions(delivered, () => Promise.resolve()).run(async (transaction) => {
      await cancelAndSave(transaction);
      throw new Error('a later write failed');
    });

    await expect(run).rejects.toThrow('a later write failed');
    expect(delivered).toEqual([]);
  });

  it('publishes nothing when the commit itself fails', async () => {
    const delivered: IEvent[] = [];
    const run = transactions(delivered, () =>
      Promise.reject(new Error('serialization failure')),
    ).run(cancelAndSave);

    await expect(run).rejects.toThrow('serialization failure');
    expect(delivered).toEqual([]);
  });

  it('refuses a save when another command committed since the load, naming the row as it stands', async () => {
    const delivered: IEvent[] = [];
    const refusal = await transactions(delivered, () => Promise.resolve(), managerMatching(0))
      .run(cancelAndSave)
      .catch((error: unknown) => error);

    expect(isDomainError(refusal) && [refusal.code, refusal.params]).toEqual([
      DomainErrorCode.STATE_CONFLICT,
      { currentVersion: 3, state: PublicationState.SCHEDULED },
    ]);
    expect(delivered).toEqual([]);
  });

  it('runs two transactions in turn, and refuses one opened inside another', async () => {
    const runner = transactions([], () => Promise.resolve());
    await runner.run(() => Promise.resolve());
    await runner.run(() => Promise.resolve());

    await expect(runner.run(() => runner.run(() => Promise.resolve()))).rejects.toThrow(
      'does not nest',
    );
  });
});
