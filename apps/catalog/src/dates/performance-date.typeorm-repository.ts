import type { EntityManager } from 'typeorm';

import { PerformanceDate, type PerformanceDateSnapshot } from './performance-date.aggregate.js';
import { PerformanceDateRow } from './performance-date.entity.js';
import { PerformanceDateRepository } from './performance-date.repository.js';

type SavedColumns = Omit<PerformanceDateRow, 'id' | 'created_at' | 'updated_at'>;

export class TypeOrmPerformanceDateRepository extends PerformanceDateRepository {
  private readonly loaded = new WeakSet<PerformanceDate>();

  public constructor(
    private readonly manager: EntityManager,
    private readonly onSaved: (date: PerformanceDate) => void,
  ) {
    super();
  }

  public async findById(id: string): Promise<PerformanceDate | null> {
    const row = await this.manager.findOneBy(PerformanceDateRow, { id });
    if (row === null) return null;
    const date = PerformanceDate.restore(snapshotOf(row));
    this.loaded.add(date);
    return date;
  }

  /** Unconditioned: the date's commands are conditioned on its publication, saved before it. */
  public async save(date: PerformanceDate): Promise<void> {
    const { id } = date.snapshot;
    // The draft command brings the INSERT, with the factory that creates a date.
    if (!this.loaded.has(date)) throw new Error(`date ${id} was not loaded in this transaction`);
    await this.manager.update(PerformanceDateRow, { id }, columnsOf(date.snapshot));
    this.onSaved(date);
  }
}

function snapshotOf(row: PerformanceDateRow): PerformanceDateSnapshot {
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

const dateOf = (instant: string | null): Date | null =>
  instant === null ? null : new Date(instant);

function columnsOf(date: PerformanceDateSnapshot): SavedColumns {
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
