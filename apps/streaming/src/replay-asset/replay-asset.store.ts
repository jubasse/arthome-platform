import type { EntityManager } from 'typeorm';

import { ReplayAssetState, type Instant } from '@arthome/core';

import type { ReplayAssetSnapshot } from './replay-asset.js';
import { recordingRefOf } from '../media/media-ports.js';

interface ReplayAssetRow {
  readonly date_id: string;
  readonly channel_id: string;
  readonly state: ReplayAssetState;
  readonly recording_ref: string | null;
  readonly recorded_until: Date | null;
  readonly stopped_at: Date | null;
  readonly announced_at: Date | null;
  readonly expires_at: Date | null;
  readonly call_attempts: number;
}

/** A locked asset: the decisions' snapshot and the attempt count the call schedule reads. */
export interface LockedAsset extends ReplayAssetSnapshot {
  readonly attempts: number;
}

function lockedOf(row: ReplayAssetRow): LockedAsset {
  return {
    dateId: row.date_id,
    channelId: row.channel_id,
    state: row.state,
    recordingRef: row.recording_ref === null ? null : recordingRefOf(row.recording_ref),
    recordedUntil: row.recorded_until?.toISOString() ?? null,
    stoppedAt: row.stopped_at?.toISOString() ?? null,
    announcedAt: row.announced_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    attempts: row.call_attempts,
  };
}

const ASSET_COLUMNS = `date_id, channel_id, state, recording_ref, recorded_until, stopped_at, announced_at,
            expires_at, call_attempts`;

/**
 * The asset's row, `FOR UPDATE SKIP LOCKED`: null when another pass holds it or it is gone. A
 *   caller decides again on what it locked, the candidates having been read without a lock.
 */
export async function lockAsset(
  manager: EntityManager,
  dateId: string,
): Promise<LockedAsset | null> {
  const [row] = await manager.query<ReplayAssetRow[]>(
    `SELECT ${ASSET_COLUMNS} FROM replay_asset WHERE date_id = $1 FOR UPDATE SKIP LOCKED`,
    [dateId],
  );
  return row === undefined ? null : lockedOf(row);
}

/**
 * The asset's row, `FOR UPDATE`, waiting for the pass holding it: a call already made writes its
 *   outcome rather than lose it to a skipped lock. Every holder is a short transaction with no
 *   provider call. Null when the row is gone.
 */
export async function lockAssetWaiting(
  manager: EntityManager,
  dateId: string,
): Promise<LockedAsset | null> {
  const [row] = await manager.query<ReplayAssetRow[]>(
    `SELECT ${ASSET_COLUMNS} FROM replay_asset WHERE date_id = $1 FOR UPDATE`,
    [dateId],
  );
  return row === undefined ? null : lockedOf(row);
}

/** The columns a transition writes; each key is a column of `replay_asset`, never user input. */
export interface AssetPatch {
  readonly state?: ReplayAssetState;
  readonly recording_ref?: string | null;
  readonly recorded_until?: Instant | null;
  readonly stopped_at?: Instant | null;
  readonly duration_sec?: number | null;
  readonly available_from?: Instant | null;
  readonly expires_at?: Instant | null;
  readonly announced_at?: Instant | null;
  readonly call_attempts?: number;
  readonly call_next_attempt_at?: Instant | null;
  readonly call_dead_at?: Instant | null;
  readonly failed_call?: string | null;
  readonly deleted_at?: Instant | null;
}

/** The next call due at once: its attempts anew, nothing scheduled. */
export const CALL_DUE_NOW = { call_attempts: 0, call_next_attempt_at: null } as const;

/** One statement on the asset's row, which the caller holds locked: the version moves with it. */
export async function patchAsset(
  manager: EntityManager,
  dateId: string,
  now: Instant,
  patch: AssetPatch,
): Promise<void> {
  const entries: [string, unknown][] = Object.entries(patch);
  const assignments = entries.map(([column], index) => `${column} = $${String(index + 3)}`);
  await manager.query(
    `UPDATE replay_asset SET ${[...assignments, 'version = version + 1', 'updated_at = $2'].join(', ')}
      WHERE date_id = $1`,
    [dateId, now, ...entries.map(([, value]): unknown => value)],
  );
}

/** Deletion owed: its attempts anew, the dead mark cleared, nothing else of the asset touched. */
export const TO_DELETING: AssetPatch = {
  state: ReplayAssetState.DELETING,
  ...CALL_DUE_NOW,
  call_dead_at: null,
  failed_call: null,
};

/** Through `replay_asset_calls_due`: $1 the instant, $2 the batch. */
export const ASSETS_DUE_SQL = `SELECT ${ASSET_COLUMNS}
       FROM replay_asset
      WHERE call_dead_at IS NULL
        AND state IN ('${ReplayAssetState.RECORDING}', '${ReplayAssetState.PROCESSING}',
                      '${ReplayAssetState.DELETING}')
        AND (state <> '${ReplayAssetState.RECORDING}' OR recording_ref IS NULL)
        AND (call_next_attempt_at IS NULL OR call_next_attempt_at <= $1)
      ORDER BY call_next_attempt_at NULLS FIRST, date_id
      LIMIT $2
        FOR UPDATE SKIP LOCKED`;

/**
 * The assets owing a call at `now`, `FOR UPDATE SKIP LOCKED` and never-called ones first, as many
 *   as `batch`. A recording started waits for its run's end and is not read.
 */
export async function lockAssetsDue(
  manager: EntityManager,
  now: Instant,
  batch: number,
): Promise<LockedAsset[]> {
  const rows = await manager.query<ReplayAssetRow[]>(ASSETS_DUE_SQL, [now, batch]);
  return rows.map(lockedOf);
}
