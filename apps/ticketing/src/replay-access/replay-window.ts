import {
  ReplayState,
  grantsReplayOnLiveEnd,
  type DateOutcome,
  type Instant,
  type ReplayPolicy,
} from '@arthome/core';

import type { ReplayStateFact } from './record-replay-state.command.js';

/** Ticketing's copy of a date's `Replay`, with what it did to the date's accesses. */
export interface ReplayWindow {
  readonly state: ReplayState;
  readonly version: bigint;
  readonly policy: ReplayPolicy;
  readonly liveEndedAt: Instant;
  readonly closesAt: Instant;
  readonly onlineAt: Instant | null;
  readonly grantedAt: Instant | null;
  readonly revokedAt: Instant | null;
}

export type ReplayWindowChange =
  | { readonly kind: 'superseded' }
  | {
      readonly kind: 'kept';
      readonly window: ReplayWindow;
      /** What the date's accesses owe the change, in its transaction. */
      readonly accesses: 'grant' | 'revoke' | null;
    };

const GRANTING_STATES: readonly ReplayState[] = [ReplayState.PENDING, ReplayState.ONLINE];

/**
 * The event carries the closing catalog computed, `replayClosesAt(liveEndedAt, windowHours)`, not
 *   the date's `replay_window_hours`, which ticketing does not keep: they are read back from it.
 */
export function windowHoursOf(liveEndedAt: Instant, closesAt: Instant): number {
  return (Date.parse(closesAt) - Date.parse(liveEndedAt)) / 3_600_000;
}

/**
 * A first-seen `online` grants (its `pending` was overtaken on a retry topic), a first-seen `closed`
 *   does not: a right to a closed window is worth nothing.
 */
export function nextReplayWindow(
  kept: ReplayWindow | null,
  fact: ReplayStateFact,
  outcome: DateOutcome | null,
  now: Instant,
): ReplayWindowChange {
  if (kept !== null && fact.version <= kept.version) return { kind: 'superseded' };
  const window: ReplayWindow = {
    state: fact.toState,
    version: fact.version,
    policy: fact.policy,
    liveEndedAt: fact.liveEndedAt,
    closesAt: fact.closesAt,
    onlineAt: fact.onlineAt,
    grantedAt: kept?.grantedAt ?? null,
    revokedAt: kept?.revokedAt ?? null,
  };
  if (window.state === ReplayState.WITHDRAWN && window.revokedAt === null) {
    return { kind: 'kept', window: { ...window, revokedAt: now }, accesses: 'revoke' };
  }
  const grants =
    GRANTING_STATES.includes(window.state) &&
    window.grantedAt === null &&
    window.revokedAt === null &&
    grantsReplayOnLiveEnd(
      window.policy,
      windowHoursOf(window.liveEndedAt, window.closesAt),
      outcome,
    );
  if (grants) return { kind: 'kept', window: { ...window, grantedAt: now }, accesses: 'grant' };
  return { kind: 'kept', window, accesses: null };
}
