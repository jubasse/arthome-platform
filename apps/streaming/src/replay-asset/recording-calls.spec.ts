import { nextAttemptAt } from '@arthome-platform/messaging';
import { describe, expect, it } from 'vitest';

import { ReplayAssetState } from '@arthome/core';

import { RECORDING_ATTEMPTS_MAX, RECORDING_RETRY_DELAYS_MS } from './recording-calls.js';
import { RecordingCall, callDue, type ReplayAssetSnapshot } from './replay-asset.js';
import { recordingRefOf } from '../media/media-ports.js';

const NOW = '2026-09-29T19:00:00.000Z';

function asset(over: Partial<ReplayAssetSnapshot>): ReplayAssetSnapshot {
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

describe('the call due', () => {
  it('starts a recording that has no reference, and waits for the end once it has one', () => {
    expect(callDue(asset({ recordingRef: null }))).toBe(RecordingCall.START);
    expect(callDue(asset({}))).toBeNull();
  });

  it('stops a processing asset, then asks its status', () => {
    const processing = asset({ state: ReplayAssetState.PROCESSING });
    expect(callDue(processing)).toBe(RecordingCall.STOP);
    expect(callDue({ ...processing, stoppedAt: NOW })).toBe(RecordingCall.STATUS);
  });

  it('stops a deleting asset that never was, then deletes it; with no reference it only deletes', () => {
    const deleting = asset({ state: ReplayAssetState.DELETING });
    expect(callDue(deleting)).toBe(RecordingCall.STOP);
    expect(callDue({ ...deleting, stoppedAt: NOW })).toBe(RecordingCall.DELETE);
    expect(callDue({ ...deleting, recordingRef: null })).toBe(RecordingCall.DELETE);
  });

  it.each([ReplayAssetState.READY, ReplayAssetState.DELETED, ReplayAssetState.FAILED])(
    'owes nothing from %s',
    (state) => {
      expect(callDue(asset({ state }))).toBeNull();
    },
  );
});

describe('the attempts of a call', () => {
  it('are bounded: the schedule answers a next attempt until the last one, then none', () => {
    const nowMs = Date.parse(NOW);
    for (let attempt = 1; attempt < RECORDING_ATTEMPTS_MAX; attempt += 1) {
      expect(nextAttemptAt(attempt, nowMs, RECORDING_RETRY_DELAYS_MS)).not.toBeNull();
    }
    expect(nextAttemptAt(RECORDING_ATTEMPTS_MAX, nowMs, RECORDING_RETRY_DELAYS_MS)).toBeNull();
  });

  it('wait longer each time up to a cap, for about an hour in all', () => {
    expect(RECORDING_RETRY_DELAYS_MS[0]).toBe(5_000);
    expect(Math.max(...RECORDING_RETRY_DELAYS_MS)).toBe(300_000);
    const total = RECORDING_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    expect(total).toBeGreaterThanOrEqual(3_600_000);
  });
});
