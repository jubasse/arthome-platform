import { describe, expect, it } from 'vitest';

import { plusSeconds, type Instant } from '@arthome/core';

import { onAirIntervalsOf } from './on-air-intervals.js';

const START: Instant = '2026-12-12T19:00:00.000Z';
const NOW = plusSeconds(START, 1_000);

function span(from: number, to: number) {
  return { start: plusSeconds(START, from), end: plusSeconds(START, to) };
}

describe('onAirIntervalsOf', () => {
  it('holds nothing before the run went on air', () => {
    expect(onAirIntervalsOf({ startedAt: null, endedAt: null, veils: [] }, NOW)).toEqual([]);
  });

  it('runs from the start to now while the run is live, and to its end once ended', () => {
    expect(onAirIntervalsOf({ startedAt: START, endedAt: null, veils: [] }, NOW)).toEqual([
      span(0, 1_000),
    ]);
    expect(
      onAirIntervalsOf({ startedAt: START, endedAt: plusSeconds(START, 600), veils: [] }, NOW),
    ).toEqual([span(0, 600)]);
  });

  it('leaves the veils out, a resolved one by its resolution and an open one up to now', () => {
    const veils = [
      { raisedAt: plusSeconds(START, 700), resolvedAt: null },
      { raisedAt: plusSeconds(START, 100), resolvedAt: plusSeconds(START, 160) },
    ];

    expect(onAirIntervalsOf({ startedAt: START, endedAt: null, veils }, NOW)).toEqual([
      span(0, 100),
      span(160, 700),
    ]);
  });

  it('clips a veil to the run and drops one the run never reached', () => {
    const veils = [
      { raisedAt: plusSeconds(START, -50), resolvedAt: plusSeconds(START, 30) },
      { raisedAt: plusSeconds(START, 900), resolvedAt: null },
    ];

    expect(
      onAirIntervalsOf({ startedAt: START, endedAt: plusSeconds(START, 800), veils }, NOW),
    ).toEqual([span(30, 800)]);
  });
});
