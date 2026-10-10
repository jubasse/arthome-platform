import {
  WatchDenialReason,
  WatchScope,
  concurrentStreamsAllowedFor,
  decideWatch,
  type Instant,
} from '@arthome/core';

import type { EntitlementFacts } from '../entitlement/entitlement-facts.js';
import type { RunFacts } from '../run/run-facts.js';

export interface ScreenCount {
  /** C2 R7: at an opening, the other screens left once it has taken over; at a renewal, the newer ones. */
  readonly open: number;
  readonly allowed: number;
}

export interface Verdict {
  readonly allowed: boolean;
  readonly scope: WatchScope;
  readonly reason: WatchDenialReason | null;
  readonly previewSecondsLeft: number;
}

export function screensAllowedBy(facts: EntitlementFacts): number {
  return concurrentStreamsAllowedFor(facts.planOpenings, facts.activeSeatsOnDate);
}

function refusedFor(reason: WatchDenialReason): Verdict {
  return { allowed: false, scope: WatchScope.NONE, reason, previewSecondsLeft: 0 };
}

/**
 * `decideWatch` on facts read fresh, failing closed on an unknown one (critical rule 10): a date
 *   whose publication or timing is unknown is not published, one whose rights are unknown is out of
 *   territory. The seat standing is unknown here (C2 R3): the BFF passes the real one.
 */
export function verdictOf(
  facts: EntitlementFacts,
  run: RunFacts | null,
  screens: ScreenCount,
  previewSecondsLeft: number,
  viewerCountry: string,
  now: Instant,
): Verdict {
  const date = facts.date;
  if (date?.publicationState == null || date.timing === null) {
    return refusedFor(WatchDenialReason.NOT_PUBLISHED);
  }
  if (date.rights === null) return refusedFor(WatchDenialReason.OUT_OF_TERRITORY);
  return decideWatch({
    holdsSeat: facts.activeSeatsOnDate > 0,
    seatExpired: facts.seatExpired,
    planOpenings: facts.planOpenings,
    concurrentStreamsOpen: screens.open,
    concurrentStreamsAllowed: screens.allowed,
    previewSecondsLeft,
    viewerCountry,
    rights: date.rights,
    timing: date.timing,
    publicationState: date.publicationState,
    runState: run?.state ?? null,
    outcome: date.outcome,
    seatStanding: null,
    now,
  });
}
