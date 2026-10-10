import {
  earliest,
  isAfter,
  isBefore,
  latest,
  previewSecondsLeft,
  previewSecondsSpent,
  previewTokenExpiresAt,
  toEpochMs,
  windowOf,
  type Instant,
  type Window,
} from '@arthome/core';

/** One account's budget on one date: what is settled, what the edge may still serve unpaid. */
export interface BudgetState {
  readonly settledSeconds: number;
  readonly prechargedSeconds: number;
  readonly coveredUntil: Instant | null;
  readonly settledUntil: Instant | null;
}

export const FRESH_BUDGET: BudgetState = {
  settledSeconds: 0,
  prechargedSeconds: 0,
  coveredUntil: null,
  settledUntil: null,
};

export interface Cover {
  readonly budget: BudgetState;
  /** How far the token just issued reaches; null when nothing is left to cover. */
  readonly expiresAt: Instant | null;
}

/** The part of the past the edge could serve and nobody has been charged for yet. */
function unsettledWindow(budget: BudgetState, now: Instant): Window | null {
  const { settledUntil, coveredUntil } = budget;
  if (settledUntil === null || coveredUntil === null) return null;
  const end = earliest(now, coveredUntil);
  return isBefore(settledUntil, end) ? windowOf(settledUntil, end) : null;
}

function spentSince(budget: BudgetState, now: Instant, onAir: readonly Window[]): number {
  const window = unsettledWindow(budget, now);
  return window === null ? 0 : previewSecondsSpent(window, onAir);
}

/** What `cover` would leave before issuing, read without writing. */
export function secondsLeftAt(budget: BudgetState, now: Instant, onAir: readonly Window[]): number {
  return previewSecondsLeft(budget.settledSeconds + spentSince(budget, now, onAir));
}

function wholeSecondsBetween(from: Instant, to: Instant): number {
  return Math.max(0, Math.ceil((toEpochMs(to) - toEpochMs(from)) / 1000));
}

/**
 * Settles the past against the on-air spans, then covers a new token: what is charged is what the
 *   edge can serve, so a token released early keeps its time covered and reopening gains nothing.
 *   Time under the veil or off air is never charged, and comes back at the settle.
 */
export function coverAt(
  budget: BudgetState,
  now: Instant,
  onAir: readonly Window[],
  spending: boolean,
): Cover {
  const settledSeconds = budget.settledSeconds + spentSince(budget, now, onAir);
  const left = previewSecondsLeft(settledSeconds);
  // Nothing in [now, covered_until) has been served unless a token reaches past now.
  const settled = { settledSeconds, prechargedSeconds: 0, settledUntil: now };
  if (left <= 0)
    return { budget: { ...settled, coveredUntil: budget.coveredUntil }, expiresAt: null };

  const expiresAt = previewTokenExpiresAt(now, left);
  const coveredUntil =
    budget.coveredUntil !== null && isAfter(budget.coveredUntil, expiresAt)
      ? budget.coveredUntil
      : expiresAt;
  return {
    budget: {
      ...settled,
      coveredUntil: latest(coveredUntil, now),
      prechargedSeconds: spending ? wholeSecondsBetween(now, coveredUntil) : 0,
    },
    expiresAt,
  };
}
