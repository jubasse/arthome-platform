import { describe, expect, it } from 'vitest';

import {
  PREVIEW_BUDGET_SECONDS,
  PLAYBACK_TOKEN_LIFETIME_SECONDS,
  plusSeconds,
  toEpochMs,
  type Instant,
  type Window,
} from '@arthome/core';

import { onAirIntervalsOf, type Veil } from './on-air-intervals.js';
import { FRESH_BUDGET, coverAt, secondsLeftAt, type BudgetState } from './preview-cover.js';

const START: Instant = '2026-12-12T19:00:00.000Z';

function at(seconds: number): Instant {
  return plusSeconds(START, seconds);
}

function seconds(from: Instant, to: Instant): number {
  return (toEpochMs(to) - toEpochMs(from)) / 1000;
}

/** A run on air from the start, with the veils given; every cover spends while the run is on air. */
function run(veils: readonly Veil[] = []) {
  const live = (now: Instant): Window[] =>
    onAirIntervalsOf({ startedAt: START, endedAt: null, veils }, now);
  const spendingAt = (now: Instant): boolean =>
    !veils.some(
      ({ raisedAt, resolvedAt }) =>
        toEpochMs(raisedAt) <= toEpochMs(now) &&
        (resolvedAt === null || toEpochMs(now) < toEpochMs(resolvedAt)),
    );
  return {
    cover(budget: BudgetState, now: Instant) {
      return coverAt(budget, now, live(now), spendingAt(now));
    },
    left(budget: BudgetState, now: Instant) {
      return secondsLeftAt(budget, now, live(now));
    },
  };
}

describe('coverAt', () => {
  it('issues 120 s on the first cover, all of it precharged', () => {
    const { budget, expiresAt } = run().cover(FRESH_BUDGET, at(10));

    expect(expiresAt).toBe(at(130));
    expect(budget).toEqual({
      settledSeconds: 0,
      prechargedSeconds: 120,
      coveredUntil: at(130),
      settledUntil: at(10),
    });
  });

  it('settles the 45 s watched at a renewal and covers 120 s again', () => {
    const live = run();
    const first = live.cover(FRESH_BUDGET, at(10)).budget;

    const { budget, expiresAt } = live.cover(first, at(55));

    expect(budget.settledSeconds).toBe(45);
    expect(expiresAt).toBe(at(175));
    expect(budget.prechargedSeconds).toBe(120);
    expect(live.left(first, at(55))).toBe(PREVIEW_BUDGET_SECONDS - 45);
  });

  it('lasts as long as what is left when less than a token remains', () => {
    const live = run();
    const nearlySpent: BudgetState = {
      settledSeconds: PREVIEW_BUDGET_SECONDS - 30,
      prechargedSeconds: 0,
      coveredUntil: at(10),
      settledUntil: at(10),
    };

    expect(live.cover(nearlySpent, at(20)).expiresAt).toBe(at(50));
  });

  it('answers null once the budget is spent', () => {
    const live = run();
    const spent: BudgetState = {
      settledSeconds: PREVIEW_BUDGET_SECONDS,
      prechargedSeconds: 0,
      coveredUntil: at(0),
      settledUntil: at(0),
    };

    expect(live.cover(spent, at(5)).expiresAt).toBeNull();
    expect(live.left(spent, at(5))).toBe(0);
  });

  it('gains nothing from a release and a reopen within the token life', () => {
    const live = run();
    const first = live.cover(FRESH_BUDGET, at(0));

    const reopened = live.cover(first.budget, at(20));

    expect(reopened.budget.settledSeconds).toBe(20);
    expect(reopened.expiresAt).toBe(at(140));
    expect(reopened.budget.settledSeconds + reopened.budget.prechargedSeconds).toBe(140);
  });

  it('gives a 60 s veil back at the next settle', () => {
    const live = run([{ raisedAt: at(30), resolvedAt: at(90) }]);
    const opened = live.cover(FRESH_BUDGET, at(0)).budget;

    const underVeil = live.cover(opened, at(45));
    const afterVeil = live.cover(underVeil.budget, at(100));

    expect(underVeil.budget.settledSeconds).toBe(30);
    expect(underVeil.budget.prechargedSeconds).toBe(0);
    expect(afterVeil.budget.settledSeconds).toBe(30 + 10);
  });

  it('never charges the time before on air', () => {
    const early = at(-300);
    const cover = coverAt(FRESH_BUDGET, early, [], false);
    const later = coverAt(cover.budget, at(-100), [], false);

    expect(later.budget.settledSeconds).toBe(0);
    expect(later.expiresAt).toBe(at(-100 + PLAYBACK_TOKEN_LIFETIME_SECONDS));
  });

  it('does not charge the gap between a lapsed token and the next cover', () => {
    const live = run();
    const first = live.cover(FRESH_BUDGET, at(0)).budget;

    const afterGap = live.cover(first, at(500));
    const next = live.cover(afterGap.budget, at(545));

    expect(afterGap.budget.settledSeconds).toBe(120);
    expect(next.budget.settledSeconds).toBe(120 + 45);
  });

  it('never lets what is spent pass the budget while spending, whatever the renewals', () => {
    const live = run();
    let budget = FRESH_BUDGET;
    for (let now = 0; now < 600; now += 45) {
      const cover = live.cover(budget, at(now));
      budget = cover.budget;
      expect(budget.settledSeconds + budget.prechargedSeconds).toBeLessThanOrEqual(
        PREVIEW_BUDGET_SECONDS,
      );
      if (cover.expiresAt === null) break;
      expect(seconds(at(now), cover.expiresAt)).toBeLessThanOrEqual(
        PLAYBACK_TOKEN_LIFETIME_SECONDS,
      );
    }
    expect(budget.settledSeconds).toBe(PREVIEW_BUDGET_SECONDS);
  });
});
