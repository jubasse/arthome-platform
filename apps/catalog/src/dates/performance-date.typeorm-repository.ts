import { AggregateTracker, saveVersioned, type Track } from '@arthome-platform/transactions';
import type { EntityManager } from 'typeorm';

import { PerformanceDate, type PerformanceDateSnapshot } from './performance-date.aggregate.js';
import { PerformanceDateRow } from './performance-date.entity.js';
import { PerformanceDateRepository } from './performance-date.repository.js';
import { PublicationRow } from './publication.entity.js';
import type { PublicationSnapshot } from './publication.js';

type DateColumns = Omit<PerformanceDateRow, 'id' | 'created_at' | 'updated_at'>;
type PublicationColumns = Omit<PublicationRow, 'date_id' | 'updated_at'>;

export class TypeOrmPerformanceDateRepository extends PerformanceDateRepository {
  private readonly tracker: AggregateTracker<PerformanceDate>;
  /** The date's snapshot as last read or written: the aggregate replaces it on every change. */
  private readonly storedSnapshots = new WeakMap<PerformanceDate, PerformanceDateSnapshot>();

  public constructor(
    private readonly manager: EntityManager,
    track: Track,
  ) {
    super();
    this.tracker = new AggregateTracker(track);
  }

  /**
   * The publication's row first, under its lock to the commit: a command's reads (the checklist
   *   facts, which `RecordChecklistFact` writes under a shared lock on the same row) then describe
   *   the version it decides on.
   */
  public async findById(id: string): Promise<PerformanceDate | null> {
    const publication = await this.manager.findOne(PublicationRow, {
      where: { date_id: id },
      lock: { mode: 'pessimistic_write' },
    });
    if (publication === null) return null;
    const row = await this.manager.findOneByOrFail(PerformanceDateRow, { id });
    const date = PerformanceDate.restore(
      performanceDateSnapshotOf(row),
      publicationSnapshotOf(publication),
    );
    this.storedSnapshots.set(date, date.snapshot);
    return this.tracker.loaded(date, publication.version);
  }

  /**
   * The publication's row first, conditioned on the loaded version: it guards the aggregate, and
   *   its row lock orders two concurrent commands before either writes the date. The date's row
   *   follows only when it changed, so its `updated_at` says when the date did. A draft inserts
   *   the date first, which its publication's row references.
   */
  public async save(date: PerformanceDate): Promise<void> {
    const { id } = date.snapshot;
    const loadedVersion = this.tracker.versionOf(date);
    if (loadedVersion === undefined) {
      await this.manager.insert(PerformanceDateRow, { id, ...dateColumnsOf(date.snapshot) });
      await this.manager.insert(PublicationRow, {
        date_id: id,
        ...publicationColumnsOf(date.publication),
      });
    } else {
      await saveVersioned(
        this.manager,
        PublicationRow,
        { date_id: id },
        loadedVersion,
        publicationColumnsOf(date.publication),
        ({ state, version }) => ({ state, version }),
      );
      if (date.snapshot !== this.storedSnapshots.get(date)) {
        await this.manager.update(PerformanceDateRow, { id }, dateColumnsOf(date.snapshot));
      }
    }
    this.storedSnapshots.set(date, date.snapshot);
    this.tracker.written(date, date.publication.version);
  }
}

export function performanceDateSnapshotOf(row: PerformanceDateRow): PerformanceDateSnapshot {
  return {
    id: row.id,
    showId: row.show_id,
    venueId: row.venue_id,
    channelId: row.channel_id,
    startsAt: row.starts_at.toISOString(),
    runtimeMin: row.runtime_min,
    replayPolicy: row.replay_policy,
    replayWindowHours: row.replay_window_hours,
    rights: row.rights,
    slug: row.slug,
    postponements: row.postponements,
    outcome: row.outcome,
    rescheduledTo: row.rescheduled_to?.toISOString() ?? null,
    outcomeDeclaredAt: row.outcome_declared_at?.toISOString() ?? null,
    outcomeMessage: row.outcome_message,
  };
}

export function publicationSnapshotOf(row: PublicationRow): PublicationSnapshot {
  return {
    dateId: row.date_id,
    channelId: row.channel_id,
    state: row.state,
    version: row.version,
    publishedAt: row.published_at?.toISOString() ?? null,
    pricesLockedAt: row.prices_locked_at?.toISOString() ?? null,
    replayOnlineAt: row.replay_online_at?.toISOString() ?? null,
  };
}

const dateOf = (instant: string | null): Date | null =>
  instant === null ? null : new Date(instant);

function dateColumnsOf(date: PerformanceDateSnapshot): DateColumns {
  return {
    show_id: date.showId,
    venue_id: date.venueId,
    channel_id: date.channelId,
    starts_at: new Date(date.startsAt),
    runtime_min: date.runtimeMin,
    replay_policy: date.replayPolicy,
    replay_window_hours: date.replayWindowHours,
    rights: date.rights,
    slug: date.slug,
    postponements: date.postponements,
    outcome: date.outcome,
    rescheduled_to: dateOf(date.rescheduledTo),
    outcome_declared_at: dateOf(date.outcomeDeclaredAt),
    outcome_message: date.outcomeMessage,
  };
}

function publicationColumnsOf(publication: PublicationSnapshot): PublicationColumns {
  return {
    channel_id: publication.channelId,
    state: publication.state,
    version: publication.version,
    published_at: dateOf(publication.publishedAt),
    prices_locked_at: dateOf(publication.pricesLockedAt),
    replay_online_at: dateOf(publication.replayOnlineAt),
  };
}
