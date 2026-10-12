import type { CheckResult } from '@arthome-platform/messaging';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';

import { FixedClock } from '@arthome/core';

import {
  DEGRADED_LOG_EVERY_MS,
  ROOM_IDLE_AFTER_MS,
  checkOrphanRecordings,
  checkReplayAssetsFailed,
  checkRoomsIdle,
  loggedWhenDegraded,
} from './replay-asset-checks.js';

const NOW = '2026-10-12T20:00:00.000Z';
const DATE_ID = '01a0d200-0000-7000-8000-000000000001';

function answering(rows: unknown[]): DataSource {
  return { query: vi.fn().mockResolvedValue(rows) } as unknown as DataSource;
}

function failing(): DataSource {
  return {
    query: vi.fn().mockRejectedValue(new Error('connection lost')),
  } as unknown as DataSource;
}

describe('the replay asset checks', () => {
  it('answer up when nothing is wrong', async () => {
    const clock = new FixedClock(NOW);
    expect(
      await checkReplayAssetsFailed(answering([{ failed: 0, oldest_date_id: null }])),
    ).toMatchObject({
      status: 'up',
    });
    expect(
      await checkOrphanRecordings(answering([{ orphans: 0, oldest_date_id: null }])),
    ).toMatchObject({
      status: 'up',
    });
    expect(
      await checkRoomsIdle(answering([{ rooms: 0, oldest_date_id: null }]), clock),
    ).toMatchObject({
      status: 'up',
    });
  });

  it('answer degraded with a count and the oldest date, never a reference', async () => {
    const clock = new FixedClock(NOW);
    expect(
      await checkReplayAssetsFailed(answering([{ failed: 2, oldest_date_id: DATE_ID }])),
    ).toEqual({
      name: 'replay_assets_failed',
      status: 'degraded',
      detail: { failed: 2, oldestDateId: DATE_ID },
    });
    expect(
      await checkOrphanRecordings(answering([{ orphans: 1, oldest_date_id: DATE_ID }])),
    ).toEqual({
      name: 'orphan_recordings',
      status: 'degraded',
      detail: { orphans: 1, oldestDateId: DATE_ID },
    });
    expect(await checkRoomsIdle(answering([{ rooms: 3, oldest_date_id: DATE_ID }]), clock)).toEqual(
      {
        name: 'rooms_idle',
        status: 'degraded',
        detail: { rooms: 3, oldestDateId: DATE_ID },
      },
    );
  });

  it('never answer down, even when the query throws', async () => {
    const clock = new FixedClock(NOW);
    const results = [
      await checkReplayAssetsFailed(failing()),
      await checkOrphanRecordings(failing()),
      await checkRoomsIdle(failing(), clock),
    ];
    expect(results.map(({ status }) => status)).toEqual(['degraded', 'degraded', 'degraded']);
  });

  it('reads the idle threshold from the clock', async () => {
    const query = vi.fn().mockResolvedValue([{ rooms: 0, oldest_date_id: null }]);
    await checkRoomsIdle({ query } as unknown as DataSource, new FixedClock(NOW));
    const params = query.mock.calls[0]?.[1] as string[];
    expect(params[2]).toBe(new Date(Date.parse(NOW) - ROOM_IDLE_AFTER_MS).toISOString());
  });
});

describe('the degraded log', () => {
  const degraded = () =>
    Promise.resolve({
      name: 'orphan_recordings',
      status: 'degraded' as const,
      detail: { orphans: 1, oldestDateId: DATE_ID },
    });
  const up = () =>
    Promise.resolve({ name: 'orphan_recordings', status: 'up' as const, detail: {} });

  it('logs the first evaluation as key=value, then at most every ten minutes', async () => {
    const clock = new FixedClock(NOW);
    const logger = { warn: vi.fn() };
    const check = loggedWhenDegraded(degraded, clock, logger);

    await check();
    await check();
    clock.advance(DEGRADED_LOG_EVERY_MS - 1);
    await check();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      `orphan_recordings degraded orphans=1 oldestDateId=${DATE_ID}`,
    );

    clock.advance(1);
    await check();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('logs nothing while up, and again at once when it degrades after recovering', async () => {
    const clock = new FixedClock(NOW);
    const logger = { warn: vi.fn() };
    let current: () => Promise<CheckResult> = degraded;
    const check = loggedWhenDegraded(() => current(), clock, logger);

    await check();
    current = up;
    await check();
    current = degraded;
    await check();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('returns the result untouched', async () => {
    const result = await loggedWhenDegraded(degraded, new FixedClock(NOW), { warn: vi.fn() })();
    expect(result.status).toBe('degraded');
  });
});
