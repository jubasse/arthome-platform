import {
  earliest,
  isAfter,
  latest,
  toEpochMs,
  windowOf,
  type Instant,
  type Window,
} from '@arthome/core';

/** A run's clock: when it went on air, when it ended, and the incident veils raised on it. */
export interface RunTimeline {
  readonly startedAt: Instant | null;
  readonly endedAt: Instant | null;
  readonly veils: readonly Veil[];
}

export interface Veil {
  readonly raisedAt: Instant;
  readonly resolvedAt: Instant | null;
}

/**
 * The spans of a run where the preview budget is spent (D-110): from `startedAt` to `endedAt` (or
 *   now), less the veils, which end at `resolvedAt` (or now). Disjoint and in order, as core's
 *   `previewSecondsSpent` needs them; before on air there are none.
 */
export function onAirIntervalsOf(timeline: RunTimeline, now: Instant): Window[] {
  const { startedAt, endedAt, veils } = timeline;
  if (startedAt === null) return [];
  const runEnd = endedAt ?? now;
  const intervals: Window[] = [];
  let cursor = startedAt;
  const ordered = [...veils].sort(
    (left, right) => toEpochMs(left.raisedAt) - toEpochMs(right.raisedAt),
  );
  for (const veil of ordered) {
    const veilStart = latest(veil.raisedAt, startedAt);
    const veilEnd = earliest(veil.resolvedAt ?? runEnd, runEnd);
    if (!isAfter(veilEnd, veilStart)) continue;
    if (isAfter(veilStart, cursor)) intervals.push(windowOf(cursor, veilStart));
    cursor = latest(cursor, veilEnd);
  }
  if (isAfter(runEnd, cursor)) intervals.push(windowOf(cursor, runEnd));
  return intervals;
}
