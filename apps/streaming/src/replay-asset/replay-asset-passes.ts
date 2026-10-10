import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import {
  DateOutcome,
  ReplayAssetState,
  RunState,
  outcomeWithdrawsReplay,
  type Clock,
} from '@arthome/core';

import { writeReplayExpired } from './replay-asset-wire.js';
import {
  closesWith,
  isExpired,
  isWithdrawn,
  owesExpiredEvent,
  shouldRecord,
} from './replay-asset.js';
import { TO_DELETING, CALL_DUE_NOW, lockAsset, patchAsset } from './replay-asset.store.js';
import { CLOCK } from '../clock.js';
import { readDateFacts } from '../entitlement/entitlement-facts.js';
import { readRunFacts } from '../run/run-facts.js';

export const REPLAY_ASSET_PASS_BATCH = 100;

/** Through `run_live`, which PS1's end by itself reads too: $1 the page's last date, $2 its size. */
export const UNRECORDED_LIVE_RUNS_SQL = `
  SELECT r.date_id, r.channel_id, r.started_at FROM run r
   WHERE r.state IN ('${RunState.ON_AIR}', '${RunState.INTERRUPTED}') AND r.started_at IS NOT NULL
     AND ($1::uuid IS NULL OR r.date_id > $1)
     AND NOT EXISTS (SELECT 1 FROM replay_asset a WHERE a.date_id = r.date_id)
   ORDER BY r.date_id
   LIMIT $2`;

/** Through `replay_asset_calls_due`: the recordings started whose run has ended. $1 the batch. */
export const ENDED_RECORDINGS_SQL = `
  SELECT a.date_id FROM replay_asset a JOIN run r ON r.date_id = a.date_id
   WHERE a.state = '${ReplayAssetState.RECORDING}' AND a.recording_ref IS NOT NULL
     AND a.call_dead_at IS NULL AND r.ended_at IS NOT NULL
   ORDER BY a.date_id
   LIMIT $1`;

/** Through `replay_asset_withdrawable`: $1 the outcomes that take a replay away, $2 the batch. */
export const WITHDRAWN_ASSETS_SQL = `
  SELECT a.date_id FROM replay_asset a JOIN entitlement_date d ON d.date_id = a.date_id
   WHERE a.state IN ('${ReplayAssetState.RECORDING}', '${ReplayAssetState.PROCESSING}',
                     '${ReplayAssetState.READY}')
     AND d.outcome = ANY($1::text[])
   ORDER BY a.date_id
   LIMIT $2`;

/** Through `replay_asset_expiring`: $1 the instant, $2 the batch. */
export const EXPIRED_ASSETS_SQL = `
  SELECT date_id FROM replay_asset
   WHERE state = '${ReplayAssetState.READY}' AND expires_at <= $1
   ORDER BY expires_at
   LIMIT $2`;

/** Outcomes core says take the replay away, so the candidate read never names one itself. */
const WITHDRAWING_OUTCOMES: readonly string[] = Object.values(DateOutcome).filter((outcome) =>
  outcomeWithdrawsReplay(outcome),
);

/*
 * Every pass reads its candidates without a lock, through a partial index, then takes each asset in
 *   a short transaction of its own, `FOR UPDATE SKIP LOCKED`, and decides again on what it locked
 *   (ticketing HANDOVER §0e). The run and the date's facts are read without a lock; the asset's row
 *   is the only one locked. No provider call is made here: the moves owe the calls (`RecordingCalls`).
 */
@Injectable()
export class ReplayAssetPasses {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Requirement 1: an asset for each live run whose date has a replay mode. */
  public async requestRecordings(batch: number = REPLAY_ASSET_PASS_BATCH): Promise<number> {
    let requested = 0;
    let after: string | null = null;
    for (;;) {
      const live: { date_id: string; channel_id: string; started_at: Date }[] =
        await this.dataSource.query(UNRECORDED_LIVE_RUNS_SQL, [after, batch]);
      for (const run of live) {
        const now = this.clock.now();
        const inserted = await this.dataSource.transaction(async (manager) => {
          if (!shouldRecord(await readDateFacts(manager, run.date_id))) return false;
          const rows = await manager.query<unknown[]>(
            `INSERT INTO replay_asset (date_id, channel_id, state, recorded_from, created_at, updated_at)
             VALUES ($1, $2, '${ReplayAssetState.RECORDING}', $3, $4, $4)
             ON CONFLICT (date_id) DO NOTHING RETURNING date_id`,
            [run.date_id, run.channel_id, run.started_at, now],
          );
          return rows.length > 0;
        });
        if (inserted) requested += 1;
      }
      const last = live.at(-1);
      if (last === undefined || live.length < batch) return requested;
      after = last.date_id;
    }
  }

  /** Requirement 2: a recording whose run has ended is processing, its stop owed. */
  public async closeRecordings(batch: number = REPLAY_ASSET_PASS_BATCH): Promise<number> {
    const due = await this.dataSource.query<{ date_id: string }[]>(ENDED_RECORDINGS_SQL, [batch]);
    return this.settleEach(due, (manager, dateId, now) => this.close(manager, dateId, now));
  }

  /** Requirement 5: the assets of a date whose outcome takes the replay away are deleted. */
  public async withdraw(batch: number = REPLAY_ASSET_PASS_BATCH): Promise<number> {
    const due = await this.dataSource.query<{ date_id: string }[]>(WITHDRAWN_ASSETS_SQL, [
      WITHDRAWING_OUTCOMES,
      batch,
    ]);
    return this.settleEach(due, (manager, dateId, now) => this.withdrawOne(manager, dateId, now));
  }

  /** Requirement 6: the replay online window has closed. */
  public async expire(batch: number = REPLAY_ASSET_PASS_BATCH): Promise<number> {
    const due = await this.dataSource.query<{ date_id: string }[]>(EXPIRED_ASSETS_SQL, [
      new Date(this.clock.now()),
      batch,
    ]);
    return this.settleEach(due, (manager, dateId, now) => this.expireOne(manager, dateId, now));
  }

  private async settleEach(
    due: readonly { date_id: string }[],
    move: (manager: EntityManager, dateId: string, now: string) => Promise<boolean>,
  ): Promise<number> {
    let settled = 0;
    for (const { date_id } of due) {
      const now = this.clock.now();
      const moved = await this.dataSource.transaction((manager) => move(manager, date_id, now));
      if (moved) settled += 1;
    }
    return settled;
  }

  private async close(manager: EntityManager, dateId: string, now: string) {
    const asset = await lockAsset(manager, dateId);
    if (asset === null) return false;
    const run = await readRunFacts(manager, dateId);
    if (run === null || !closesWith(asset, run.endedAt)) return false;
    await patchAsset(manager, dateId, now, {
      state: ReplayAssetState.PROCESSING,
      recorded_until: run.endedAt,
      ...CALL_DUE_NOW,
    });
    return true;
  }

  private async withdrawOne(manager: EntityManager, dateId: string, now: string) {
    const asset = await lockAsset(manager, dateId);
    if (asset === null) return false;
    const facts = await readDateFacts(manager, dateId);
    if (!isWithdrawn(asset, facts?.outcome ?? null)) return false;
    await this.toDeleting(manager, asset, now);
    return true;
  }

  private async expireOne(manager: EntityManager, dateId: string, now: string) {
    const asset = await lockAsset(manager, dateId);
    if (asset === null || !isExpired(asset, now)) return false;
    await this.toDeleting(manager, asset, now);
    return true;
  }

  private async toDeleting(
    manager: EntityManager,
    asset: Parameters<typeof owesExpiredEvent>[0],
    now: string,
  ): Promise<void> {
    if (owesExpiredEvent(asset)) await writeReplayExpired(manager, asset.dateId, now);
    await patchAsset(manager, asset.dateId, now, TO_DELETING);
  }
}
