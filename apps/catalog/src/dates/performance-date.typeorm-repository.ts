import type { EntityManager } from 'typeorm';

import { stateConflict } from './conflict.js';
import { PerformanceDate, type PerformanceDateSnapshot } from './performance-date.aggregate.js';
import { PerformanceDateRow } from './performance-date.entity.js';
import { PerformanceDateRepository } from './performance-date.repository.js';
import { PublicationRow } from './publication.entity.js';
import type { PublicationSnapshot } from './publication.js';

type DateColumns = Omit<PerformanceDateRow, 'id' | 'created_at' | 'updated_at'>;
type PublicationColumns = Omit<PublicationRow, 'date_id' | 'updated_at'>;

export class TypeOrmPerformanceDateRepository extends PerformanceDateRepository {
  /** The version each loaded date was read at: the condition of its save. */
  private readonly loadedVersions = new WeakMap<PerformanceDate, number>();

  public constructor(
    private readonly manager: EntityManager,
    private readonly onSaved: (date: PerformanceDate) => void,
  ) {
    super();
  }

  public async findById(id: string): Promise<PerformanceDate | null> {
    const row = await this.manager.findOneBy(PerformanceDateRow, { id });
    if (row === null) return null;
    const publication = await this.manager.findOneBy(PublicationRow, { date_id: id });
    if (publication === null) throw new Error(`date ${id} has no publication`);
    const date = PerformanceDate.restore(
      performanceDateSnapshotOf(row),
      publicationSnapshotOf(publication),
    );
    this.loadedVersions.set(date, publication.version);
    return date;
  }

  /**
   * The publication's row first, conditioned on the loaded version (`nestjs-typeorm` rule 7): its
   *   row lock orders two concurrent commands before either writes the date. A draft inserts the
   *   date first, which its publication's row references.
   */
  public async save(date: PerformanceDate): Promise<void> {
    const { id } = date.snapshot;
    const loadedVersion = this.loadedVersions.get(date);
    if (loadedVersion === undefined) {
      await this.manager.insert(PerformanceDateRow, { id, ...dateColumnsOf(date.snapshot) });
      await this.manager.insert(PublicationRow, {
        date_id: id,
        ...publicationColumnsOf(date.publication),
      });
    } else {
      const { affected } = await this.manager.update(
        PublicationRow,
        { date_id: id, version: loadedVersion },
        publicationColumnsOf(date.publication),
      );
      if (affected !== 1) {
        throw stateConflict(await this.manager.findOneByOrFail(PublicationRow, { date_id: id }));
      }
      await this.manager.update(PerformanceDateRow, { id }, dateColumnsOf(date.snapshot));
    }
    this.loadedVersions.set(date, date.publication.version);
    this.onSaved(date);
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
