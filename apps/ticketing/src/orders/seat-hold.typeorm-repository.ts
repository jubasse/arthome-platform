import { AggregateTracker, saveVersioned, type Track } from '@arthome-platform/transactions';
import type { EntityManager } from 'typeorm';

import { SeatHold, type SeatHoldSnapshot } from './seat-hold.aggregate.js';
import { SeatHoldRow } from './seat-hold.entity.js';
import { SeatHoldRepository } from './seat-hold.repository.js';

export class TypeOrmSeatHoldRepository extends SeatHoldRepository {
  private readonly tracker: AggregateTracker<SeatHold>;

  public constructor(
    private readonly manager: EntityManager,
    track: Track,
  ) {
    super();
    this.tracker = new AggregateTracker(track);
  }

  public async findById(holdId: string): Promise<SeatHold | null> {
    const row = await this.manager.findOne(SeatHoldRow, {
      where: { id: holdId },
      lock: { mode: 'pessimistic_write' },
    });
    if (row === null) return null;
    return this.tracker.loaded(SeatHold.restore(seatHoldSnapshotOf(row)), row.version);
  }

  public async save(hold: SeatHold): Promise<void> {
    const current = hold.snapshot;
    const loadedVersion = this.tracker.versionOf(hold);
    if (loadedVersion === undefined) {
      await this.manager.insert(SeatHoldRow, {
        id: current.id,
        date_id: current.dateId,
        account_id: current.accountId,
        profile_id: current.profileId,
        tier: current.tier,
        quantity: current.quantity,
        origin: current.origin,
        origin_ref: current.originRef,
        expires_at: new Date(current.expiresAt),
        state: current.state,
        version: current.version,
      });
    } else {
      await saveVersioned(
        this.manager,
        SeatHoldRow,
        { id: current.id },
        loadedVersion,
        { state: current.state, version: current.version },
        ({ version }) => ({ currentVersion: version }),
      );
    }
    this.tracker.written(hold, current.version);
  }
}

function seatHoldSnapshotOf(row: SeatHoldRow): SeatHoldSnapshot {
  return {
    id: row.id,
    dateId: row.date_id,
    accountId: row.account_id,
    profileId: row.profile_id,
    tier: row.tier,
    quantity: row.quantity,
    origin: row.origin,
    originRef: row.origin_ref,
    expiresAt: row.expires_at.toISOString(),
    state: row.state,
    version: row.version,
  };
}
