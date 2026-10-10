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

/** A run on air from the start, with the veils given. */
function run(veils: readonly Veil[] = []) {
  const live = (now: Instant): Window[] =>
    onAirIntervalsOf({ startedAt: START, endedAt: null, veils }, now);
  return {
    cover(budget: BudgetState, now: Instant) {
      return coverAt(budget, now, live(now));
    },
    left(budget: BudgetState, now: Instant) {
      return secondsLeftAt(budget, now, live(now));
    },
  };
}

/** Renews every `everyMs` from the start until refused: how far the edge could serve, at most. */
function servedRenewingEvery(everyMs: number): { servedSeconds: number; budget: BudgetState } {
  const live = run();
  let budget = FRESH_BUDGET;
  let servedUntil = START;
  for (let elapsedMs = 0; elapsedMs < 3_600_000; elapsedMs += everyMs) {
    const cover = live.cover(budget, plusMs(START, elapsedMs));
    budget = cover.budget;
    if (cover.expiresAt === null) break;
    if (toEpochMs(cover.expiresAt) > toEpochMs(servedUntil)) servedUntil = cover.expiresAt;
  }
  return { servedSeconds: seconds(START, servedUntil), budget };
}

function plusMs(instant: Instant, ms: number): Instant {
  return new Date(toEpochMs(instant) + ms).toISOString();
}

describe('coverAt', () => {
  it('issues 120 s on the first cover, charging nothing yet', () => {
    const { budget, expiresAt } = run().cover(FRESH_BUDGET, at(10));

    expect(expiresAt).toBe(at(130));
    expect(budget).toEqual({ settledMs: 0, coveredUntil: at(130), settledUntil: at(10) });
  });

  it('settles the 45 s watched at a renewal and covers 120 s again', () => {
    const live = run();
    const first = live.cover(FRESH_BUDGET, at(10)).budget;

    const { budget, expiresAt } = live.cover(first, at(55));

    expect(budget.settledMs).toBe(45_000);
    expect(expiresAt).toBe(at(175));
    expect(live.left(first, at(55))).toBe(PREVIEW_BUDGET_SECONDS - 45);
  });

  it('lasts as long as what is left when less than a token remains', () => {
    const live = run();
    const nearlySpent: BudgetState = {
      settledMs: (PREVIEW_BUDGET_SECONDS - 30) * 1000,
      coveredUntil: at(10),
      settledUntil: at(10),
    };

    expect(live.cover(nearlySpent, at(20)).expiresAt).toBe(at(50));
  });

  it('answers null once the budget is spent', () => {
    const live = run();
    const spent: BudgetState = {
      settledMs: PREVIEW_BUDGET_SECONDS * 1000,
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

    expect(reopened.budget.settledMs).toBe(20_000);
    expect(reopened.expiresAt).toBe(at(140));
    expect(reopened.budget.coveredUntil).toBe(at(140));
  });

  it('gives a 60 s veil back at the next settle', () => {
    const live = run([{ raisedAt: at(30), resolvedAt: at(90) }]);
    const opened = live.cover(FRESH_BUDGET, at(0)).budget;

    const underVeil = live.cover(opened, at(45));
    const afterVeil = live.cover(underVeil.budget, at(100));

    expect(underVeil.budget.settledMs).toBe(30_000);
    expect(afterVeil.budget.settledMs).toBe((30 + 10) * 1000);
  });

  it('never charges the time before on air', () => {
    const early = at(-300);
    const cover = coverAt(FRESH_BUDGET, early, []);
    const later = coverAt(cover.budget, at(-100), []);

    expect(later.budget.settledMs).toBe(0);
    expect(later.expiresAt).toBe(at(-100 + PLAYBACK_TOKEN_LIFETIME_SECONDS));
  });

  it('does not charge the gap between a lapsed token and the next cover', () => {
    const live = run();
    const first = live.cover(FRESH_BUDGET, at(0)).budget;

    const afterGap = live.cover(first, at(500));
    const next = live.cover(afterGap.budget, at(545));

    expect(afterGap.budget.settledMs).toBe(120_000);
    expect(next.budget.settledMs).toBe((120 + 45) * 1000);
  });

  it('never lets what is settled and covered ahead pass the budget, at 45 s renewals', () => {
    const live = run();
    let budget = FRESH_BUDGET;
    for (let now = 0; now < 600; now += 45) {
      const cover = live.cover(budget, at(now));
      budget = cover.budget;
      const aheadMs = Math.max(0, toEpochMs(budget.coveredUntil ?? at(now)) - toEpochMs(at(now)));
      expect(budget.settledMs + aheadMs).toBeLessThanOrEqual(PREVIEW_BUDGET_SECONDS * 1000);
      if (cover.expiresAt === null) break;
      expect(seconds(at(now), cover.expiresAt)).toBeLessThanOrEqual(
        PLAYBACK_TOKEN_LIFETIME_SECONDS,
      );
    }
    expect(budget.settledMs).toBe(PREVIEW_BUDGET_SECONDS * 1000);
  });

  it.each([900, 1999, 45_000, 250])(
    'never serves more than the budget on air when renewing every %i ms',
    (everyMs) => {
      const { servedSeconds, budget } = servedRenewingEvery(everyMs);

      expect(servedSeconds).toBeLessThanOrEqual(PREVIEW_BUDGET_SECONDS);
      expect(servedSeconds).toBeGreaterThan(PREVIEW_BUDGET_SECONDS - 1);
      expect(budget.settledMs).toBeLessThanOrEqual(PREVIEW_BUDGET_SECONDS * 1000);
    },
  );

  it('charges the milliseconds of a sub-second settle', () => {
    const live = run();
    const opened = live.cover(FRESH_BUDGET, at(0)).budget;

    const renewed = live.cover(opened, plusMs(at(0), 900)).budget;

    expect(renewed.settledMs).toBe(900);
    expect(live.left(renewed, plusMs(at(0), 900))).toBe(PREVIEW_BUDGET_SECONDS - 1);
  });
});
