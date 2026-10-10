import {
  ReplayAssetState,
  hasReplayPolicy,
  isAfter,
  outcomeWithdrawsReplay,
  replayClosesAt,
  type DateOutcome,
  type DateTiming,
  type Instant,
} from '@arthome/core';

import type { RecordingRef } from '../media/media-ports.js';

/** The provider calls an asset can owe, named as the `failed_call` column and the logs name them. */
export const RecordingCall = {
  START: 'start',
  STOP: 'stop',
  STATUS: 'status',
  DELETE: 'delete',
} as const;
export type RecordingCall = (typeof RecordingCall)[keyof typeof RecordingCall];

/** An asset row as the decisions read it. */
export interface ReplayAssetSnapshot {
  readonly dateId: string;
  readonly channelId: string;
  readonly state: ReplayAssetState;
  readonly recordingRef: RecordingRef | null;
  readonly recordedUntil: Instant | null;
  readonly stoppedAt: Instant | null;
  readonly announcedAt: Instant | null;
  readonly expiresAt: Instant | null;
}

/**
 * Whether a run on air or interrupted is to be recorded: its date has a replay mode (D-112) and
 *   no outcome that takes the replay away (D-092). A date whose timing is not projected yet is
 *   looked at again on the next pass.
 */
export function shouldRecord(
  facts: { readonly timing: DateTiming | null; readonly outcome: DateOutcome | null } | null,
): boolean {
  if (facts?.timing == null) return false;
  return hasReplayPolicy(facts.timing) && !outcomeWithdrawsReplay(facts.outcome);
}

/** The recording closes with its run's end, which `interrupted` is not (the veil records on). */
export function closesWith(asset: ReplayAssetSnapshot, runEndedAt: Instant | null): boolean {
  return (
    asset.state === ReplayAssetState.RECORDING && asset.recordingRef !== null && runEndedAt !== null
  );
}

/** A state a withdrawal can still reach; a failed asset is the operator's, no pass takes it back. */
export function canBeWithdrawn(state: ReplayAssetState): boolean {
  return (
    state === ReplayAssetState.RECORDING ||
    state === ReplayAssetState.PROCESSING ||
    state === ReplayAssetState.READY
  );
}

export function isWithdrawn(asset: ReplayAssetSnapshot, outcome: DateOutcome | null): boolean {
  return canBeWithdrawn(asset.state) && outcomeWithdrawsReplay(outcome);
}

export function isExpired(asset: ReplayAssetSnapshot, now: Instant): boolean {
  return (
    asset.state === ReplayAssetState.READY &&
    asset.expiresAt !== null &&
    !isAfter(asset.expiresAt, now)
  );
}

/**
 * The call an asset owes, read from its state: a recording not started starts; a processing one
 *   not stopped stops, then is polled; a deleting one is stopped first when it never was, then
 *   deleted. A recording started waits for its run to end, and the rest owe nothing.
 */
export function callDue(asset: ReplayAssetSnapshot): RecordingCall | null {
  const { state, recordingRef, stoppedAt } = asset;
  switch (state) {
    case ReplayAssetState.RECORDING:
      return recordingRef === null ? RecordingCall.START : null;
    case ReplayAssetState.PROCESSING:
      return stoppedAt === null ? RecordingCall.STOP : RecordingCall.STATUS;
    case ReplayAssetState.DELETING:
      return recordingRef !== null && stoppedAt === null
        ? RecordingCall.STOP
        : RecordingCall.DELETE;
    default:
      return null;
  }
}

export type Readiness =
  | { readonly kind: 'withdrawn' }
  | {
      readonly kind: 'opens';
      readonly availableFrom: Instant;
      readonly expiresAt: Instant;
    };

/**
 * A poll that answered ready: the replay opens from now and closes once, computed from the run's
 *   real end and the date's window (`adr-replay.md` §4), unless the date's outcome has taken the
 *   replay away by then, or the window has already closed: a replay never online is not announced.
 */
export function readinessAt(
  now: Instant,
  runEndedAt: Instant,
  facts: { readonly timing: DateTiming; readonly outcome: DateOutcome | null },
): Readiness {
  if (outcomeWithdrawsReplay(facts.outcome)) return { kind: 'withdrawn' };
  const expiresAt = replayClosesAt(runEndedAt, facts.timing.replayWindowHours);
  if (!isAfter(expiresAt, now)) return { kind: 'withdrawn' };
  return { kind: 'opens', availableFrom: now, expiresAt };
}

/** Only an asset whose readiness was announced has an expiry to announce. */
export function owesExpiredEvent(asset: ReplayAssetSnapshot): boolean {
  return asset.state === ReplayAssetState.READY && asset.announcedAt !== null;
}
