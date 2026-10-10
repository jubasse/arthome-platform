import {
  earliest,
  isAfter,
  isBefore,
  latest,
  previewSecondsLeft,
  previewTokenExpiresAt,
  toEpochMs,
  windowOf,
  type Instant,
  type Window,
} from '@arthome/core';

/** One account's budget on one date: what is settled, and how far the edge may serve. */
export interface BudgetState {
  readonly settledMs: number;
  readonly coveredUntil: Instant | null;
  readonly settledUntil: Instant | null;
}

export const FRESH_BUDGET: BudgetState = {
  settledMs: 0,
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

/**
 * The milliseconds of `window` inside the disjoint on-air spans. Core's `previewSecondsSpent`
 *   floors to whole seconds, which a client renewing faster than once a second would never pay.
 */
function onAirMsWithin(window: Window, onAir: readonly Window[]): number {
  const start = toEpochMs(window.start);
  const end = toEpochMs(window.end);
  return onAir.reduce(
    (sum, span) =>
      sum +
      Math.max(0, Math.min(end, toEpochMs(span.end)) - Math.max(start, toEpochMs(span.start))),
    0,
  );
}

function settledMsAt(budget: BudgetState, now: Instant, onAir: readonly Window[]): number {
  const window = unsettledWindow(budget, now);
  return budget.settledMs + (window === null ? 0 : onAirMsWithin(window, onAir));
}

/** A started second counts whole, so a token never reaches past the milliseconds left. */
function secondsLeftOf(settledMs: number): number {
  return previewSecondsLeft(Math.ceil(settledMs / 1000));
}

/** What `cover` would leave before issuing, read without writing. */
export function secondsLeftAt(budget: BudgetState, now: Instant, onAir: readonly Window[]): number {
  return secondsLeftOf(settledMsAt(budget, now, onAir));
}

/**
 * Settles the past against the on-air spans, then covers a new token: what is charged is what the
 *   edge can serve, so a token released early keeps its time covered and reopening gains nothing.
 *   Time under the veil or off air is never charged, and comes back at the settle.
 */
export function coverAt(budget: BudgetState, now: Instant, onAir: readonly Window[]): Cover {
  const settledMs = settledMsAt(budget, now, onAir);
  const left = secondsLeftOf(settledMs);
  // Nothing in [now, covered_until) has been served unless a token reaches past now.
  const settled = { settledMs, settledUntil: now };
  if (left <= 0)
    return { budget: { ...settled, coveredUntil: budget.coveredUntil }, expiresAt: null };

  const expiresAt = previewTokenExpiresAt(now, left);
  const coveredUntil =
    budget.coveredUntil !== null && isAfter(budget.coveredUntil, expiresAt)
      ? budget.coveredUntil
      : expiresAt;
  return { budget: { ...settled, coveredUntil: latest(coveredUntil, now) }, expiresAt };
}
