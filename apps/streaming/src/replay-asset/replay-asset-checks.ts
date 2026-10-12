import { boundedCheck, type CheckResult } from '@arthome-platform/messaging';
import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { DateOutcome, MINUTE_MS, ReplayAssetState, RunState, type Clock } from '@arthome/core';

/** An alerting floor, with no product meaning: a run not on air this long after its date began. */
export const ROOM_IDLE_AFTER_MS = 30 * MINUTE_MS;

/** A degraded check is logged on its first evaluation, then at most this often while it stays so. */
export const DEGRADED_LOG_EVERY_MS = 10 * MINUTE_MS;

type Check = () => Promise<CheckResult>;

/** A replay asset given up on: an operator reads it (HANDOVER §0f). */
export function checkReplayAssetsFailed(dataSource: DataSource): Promise<CheckResult> {
  return boundedCheck('replay_assets_failed', 'degraded', async () => {
    const [row] = await dataSource.query<{ failed: number; oldest_date_id: string | null }[]>(
      `SELECT count(*)::int AS failed,
              (array_agg(date_id ORDER BY call_dead_at))[1] AS oldest_date_id
         FROM replay_asset WHERE state = $1`,
      [ReplayAssetState.FAILED],
    );
    const failed = row?.failed ?? 0;
    return {
      status: failed === 0 ? 'up' : 'degraded',
      detail: { failed, oldestDateId: row?.oldest_date_id ?? null },
    };
  });
}

/** Recordings the provider keeps and no asset owns. The reference is never read here. */
export function checkOrphanRecordings(dataSource: DataSource): Promise<CheckResult> {
  return boundedCheck('orphan_recordings', 'degraded', async () => {
    const [row] = await dataSource.query<{ orphans: number; oldest_date_id: string | null }[]>(
      `SELECT count(*)::int AS orphans,
              (array_agg(date_id ORDER BY created_at))[1] AS oldest_date_id
         FROM orphan_recording`,
    );
    const orphans = row?.orphans ?? 0;
    return {
      status: orphans === 0 ? 'up' : 'degraded',
      detail: { orphans, oldestDateId: row?.oldest_date_id ?? null },
    };
  });
}

/**
 * A known run not yet on air while its date began long ago (core `displayStateOf`: the room stays
 *   open until the run goes on air or an outcome is declared). A postponed date is not yet over.
 */
export function checkRoomsIdle(dataSource: DataSource, clock: Clock): Promise<CheckResult> {
  return boundedCheck('rooms_idle', 'degraded', async () => {
    const startedBefore = new Date(clock.nowMs() - ROOM_IDLE_AFTER_MS).toISOString();
    const [row] = await dataSource.query<{ rooms: number; oldest_date_id: string | null }[]>(
      `SELECT count(*)::int AS rooms,
              (array_agg(run.date_id ORDER BY date.starts_at))[1] AS oldest_date_id
         FROM run
         JOIN entitlement_date AS date ON date.date_id = run.date_id
        WHERE run.state IN ($1, $2)
          AND date.starts_at < $3
          AND (date.outcome IS NULL OR date.outcome = $4)`,
      [RunState.IDLE, RunState.REHEARSAL, startedBefore, DateOutcome.POSTPONED],
    );
    const rooms = row?.rooms ?? 0;
    return {
      status: rooms === 0 ? 'up' : 'degraded',
      detail: { rooms, oldestDateId: row?.oldest_date_id ?? null },
    };
  });
}

/**
 * The check, plus one `warn` line when it answers `degraded`: on the first evaluation, then at most
 *   every `everyMs` while it stays so. A probe polled every few seconds must not flood the log; a
 *   check that recovers starts over.
 */
export function loggedWhenDegraded(
  check: Check,
  clock: Clock,
  logger: Pick<Logger, 'warn'> = new Logger('ReadinessChecks'),
  everyMs: number = DEGRADED_LOG_EVERY_MS,
): Check {
  let lastLoggedMs: number | null = null;
  return async () => {
    const result = await check();
    if (result.status !== 'degraded') {
      lastLoggedMs = null;
      return result;
    }
    const nowMs = clock.nowMs();
    if (lastLoggedMs === null || nowMs - lastLoggedMs >= everyMs) {
      lastLoggedMs = nowMs;
      const detail = Object.entries(result.detail)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ');
      logger.warn(`${result.name} degraded ${detail}`);
    }
    return result;
  };
}
