import { describe, expect, it } from 'vitest';

import {
  DateOutcome,
  DomainConstant,
  REPLAY_ASSET_STATES,
  ReplayAssetState,
  ReplayPolicy,
  plusMinutes,
  type DateTiming,
} from '@arthome/core';

import {
  canBeWithdrawn,
  closesWith,
  isExpired,
  isWithdrawn,
  owesExpiredEvent,
  readinessAt,
  shouldRecord,
  type ReplayAssetSnapshot,
} from './replay-asset.js';
import { recordingRefOf } from '../media/media-ports.js';

const NOW = '2026-09-29T19:00:00.000Z';

function timingWith(replayPolicy: ReplayPolicy, replayWindowHours = 48): DateTiming {
  return {
    startsAt: NOW,
    runtimeMin: 90,
    roomOpensBeforeMin: DomainConstant.ROOM_OPENS_MINUTES_BEFORE,
    replayPolicy,
    replayWindowHours,
  };
}

function asset(over: Partial<ReplayAssetSnapshot> = {}): ReplayAssetSnapshot {
  return {
    dateId: 'date',
    channelId: 'channel',
    state: ReplayAssetState.RECORDING,
    recordingRef: recordingRefOf('ref'),
    recordedUntil: null,
    stoppedAt: null,
    announcedAt: null,
    expiresAt: null,
    ...over,
  };
}

const MODES = Object.values(ReplayPolicy).filter((policy) => policy !== ReplayPolicy.NONE);

describe('a recording requested', () => {
  it.each(MODES)('for a date with the %s replay mode', (policy) => {
    expect(shouldRecord({ timing: timingWith(policy), outcome: null })).toBe(true);
  });

  it('for no date without a mode, with no timing projected yet, or with the replay withdrawn', () => {
    expect(shouldRecord({ timing: timingWith(ReplayPolicy.NONE), outcome: null })).toBe(false);
    expect(shouldRecord({ timing: null, outcome: null })).toBe(false);
    expect(shouldRecord(null)).toBe(false);
    for (const outcome of [DateOutcome.CANCELLED, DateOutcome.INTERRUPTED]) {
      expect(shouldRecord({ timing: timingWith(MODES[0] as ReplayPolicy), outcome })).toBe(false);
    }
  });

  it('for a postponed date, which withdraws nothing', () => {
    expect(
      shouldRecord({
        timing: timingWith(MODES[0] as ReplayPolicy),
        outcome: DateOutcome.POSTPONED,
      }),
    ).toBe(true);
  });
});

describe('a recording closed', () => {
  it('when its run has ended and the provider started it', () => {
    expect(closesWith(asset(), NOW)).toBe(true);
  });

  it('never while its run is live, before the provider started it, or from another state', () => {
    expect(closesWith(asset(), null)).toBe(false);
    expect(closesWith(asset({ recordingRef: null }), NOW)).toBe(false);
    expect(closesWith(asset({ state: ReplayAssetState.PROCESSING }), NOW)).toBe(false);
  });
});

describe('a readiness', () => {
  const facts = { timing: timingWith(MODES[0] as ReplayPolicy, 48), outcome: null };

  it('opens now and closes once, from the run end and the window, an overrun included', () => {
    const endedAt = plusMinutes(NOW, 150);
    expect(readinessAt(plusMinutes(endedAt, 12), endedAt, facts)).toEqual({
      kind: 'opens',
      availableFrom: plusMinutes(endedAt, 12),
      expiresAt: plusMinutes(endedAt, 48 * 60),
    });
  });

  it('is a withdrawal when the date no longer has a replay', () => {
    expect(readinessAt(NOW, NOW, { ...facts, outcome: DateOutcome.INTERRUPTED })).toEqual({
      kind: 'withdrawn',
    });
  });

  it('is a withdrawal, never an announcement, once the window has closed', () => {
    const closing = plusMinutes(NOW, 48 * 60);
    expect(readinessAt(closing, NOW, facts)).toEqual({ kind: 'withdrawn' });
    expect(readinessAt(plusMinutes(closing, -1), NOW, facts)).toMatchObject({ kind: 'opens' });
  });
});

describe('a withdrawal', () => {
  const reachable = REPLAY_ASSET_STATES.filter((state) => canBeWithdrawn(state));

  it('reaches an asset recording, processing or ready, and none that is on its way out or failed', () => {
    expect(reachable).toEqual([
      ReplayAssetState.RECORDING,
      ReplayAssetState.PROCESSING,
      ReplayAssetState.READY,
    ]);
  });

  it.each(reachable)('moves a %s asset when the date is cancelled or interrupted', (state) => {
    for (const outcome of [DateOutcome.CANCELLED, DateOutcome.INTERRUPTED]) {
      expect(isWithdrawn(asset({ state }), outcome)).toBe(true);
    }
    expect(isWithdrawn(asset({ state }), DateOutcome.POSTPONED)).toBe(false);
    expect(isWithdrawn(asset({ state }), null)).toBe(false);
  });

  it.each([ReplayAssetState.DELETING, ReplayAssetState.DELETED, ReplayAssetState.FAILED])(
    'never moves a %s asset',
    (state) => {
      expect(isWithdrawn(asset({ state }), DateOutcome.CANCELLED)).toBe(false);
    },
  );
});

describe('an expiry', () => {
  const ready = asset({ state: ReplayAssetState.READY, expiresAt: NOW });

  it('is due at the closing instant, not a millisecond before', () => {
    expect(isExpired(ready, plusMinutes(NOW, -1))).toBe(false);
    expect(isExpired(ready, NOW)).toBe(true);
  });

  it('moves a ready asset alone: deleted is final, deleting is on its way', () => {
    for (const state of [ReplayAssetState.DELETING, ReplayAssetState.DELETED]) {
      expect(isExpired({ ...ready, state }, NOW)).toBe(false);
    }
  });

  it('is announced only for an asset whose readiness was', () => {
    expect(owesExpiredEvent({ ...ready, announcedAt: NOW })).toBe(true);
    expect(owesExpiredEvent(ready)).toBe(false);
    expect(owesExpiredEvent(asset({ state: ReplayAssetState.PROCESSING, announcedAt: null }))).toBe(
      false,
    );
  });
});
