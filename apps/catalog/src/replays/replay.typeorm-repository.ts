import { AggregateTracker, saveVersioned, type Track } from '@arthome-platform/transactions';
import type { EntityManager } from 'typeorm';

import { Replay, type ReplaySnapshot } from './replay.aggregate.js';
import { ReplayRow } from './replay.entity.js';
import { ReplayRepository } from './replay.repository.js';

type ReplayColumns = Omit<ReplayRow, 'date_id' | 'created_at' | 'updated_at'>;

export class TypeOrmReplayRepository extends ReplayRepository {
  private readonly tracker: AggregateTracker<Replay>;

  public constructor(
    private readonly manager: EntityManager,
    track: Track,
  ) {
    super();
    this.tracker = new AggregateTracker(track);
  }

  public async findByDate(dateId: string): Promise<Replay | null> {
    const row = await this.manager.findOne(ReplayRow, {
      where: { date_id: dateId },
      lock: { mode: 'pessimistic_write' },
    });
    if (row === null) return null;
    return this.tracker.loaded(Replay.restore(replaySnapshotOf(row)), row.version);
  }

  public async save(replay: Replay): Promise<void> {
    const { snapshot } = replay;
    const loadedVersion = this.tracker.versionOf(replay);
    if (loadedVersion === undefined) {
      await this.manager.insert(ReplayRow, { date_id: snapshot.dateId, ...columnsOf(snapshot) });
    } else {
      await saveVersioned(
        this.manager,
        ReplayRow,
        { date_id: snapshot.dateId },
        loadedVersion,
        columnsOf(snapshot),
        ({ state, version }) => ({ currentVersion: version, state }),
      );
    }
    this.tracker.written(replay, snapshot.version);
  }
}

const instantOf = (date: Date | null): string | null => date?.toISOString() ?? null;
const dateOf = (instant: string | null): Date | null =>
  instant === null ? null : new Date(instant);

export function replaySnapshotOf(row: ReplayRow): ReplaySnapshot {
  return {
    dateId: row.date_id,
    channelId: row.channel_id,
    state: row.state,
    policy: row.policy,
    liveEndedAt: row.live_ended_at.toISOString(),
    closesAt: row.closes_at.toISOString(),
    assetDurationSec: row.asset_duration_sec,
    assetReadyAt: instantOf(row.asset_ready_at),
    onlineAt: instantOf(row.online_at),
    closedAt: instantOf(row.closed_at),
    withdrawnAt: instantOf(row.withdrawn_at),
    version: row.version,
  };
}

function columnsOf(replay: ReplaySnapshot): ReplayColumns {
  return {
    channel_id: replay.channelId,
    state: replay.state,
    policy: replay.policy,
    live_ended_at: new Date(replay.liveEndedAt),
    closes_at: new Date(replay.closesAt),
    asset_duration_sec: replay.assetDurationSec,
    asset_ready_at: dateOf(replay.assetReadyAt),
    online_at: dateOf(replay.onlineAt),
    closed_at: dateOf(replay.closedAt),
    withdrawn_at: dateOf(replay.withdrawnAt),
    version: replay.version,
  };
}
