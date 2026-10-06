import { describe, expect, it } from 'vitest';

import {
  JITTER_RATIO,
  PermanentError,
  RETRY_DELAYS_MS,
  attemptsAllowedBy,
  deadLetterTopic,
  doublingDelays,
  nextAttemptAt,
  retryDelayAfter,
  retryTopic,
  routeFailure,
} from './failure.js';

const NOW = new Date('2026-09-25T00:00:00.000Z');

describe('routeFailure', () => {
  it('dead-letters a permanent failure AT ONCE, with no replay', () => {
    // A malformed payload fails identically however long you wait. Retrying it
    // three times only delays the moment somebody looks at it.
    expect(routeFailure(new PermanentError('malformed'), 0, NOW)).toEqual({
      kind: 'dlq',
      reason: 'permanent',
    });
  });

  it('retries a transient failure on the schedule events.md gives', () => {
    // random() pinned to 0 so the schedule is the bare delay.
    const first = routeFailure(new Error('connection refused'), 0, NOW, () => 0);
    expect(first).toEqual({
      kind: 'retry',
      attempt: 1,
      notBefore: new Date(NOW.getTime() + 5_000),
    });
  });

  it('spreads retries with jitter, so a thousand failures do not return at once', () => {
    // Everything that failed during one outage failed within milliseconds. A
    // fixed delay sends all of it back at the same instant, onto a dependency
    // that has just come up.
    const at = (r: number) => {
      const route = routeFailure(new Error('down'), 0, NOW, () => r);
      if (route.kind !== 'retry') throw new Error('expected a retry');
      return route.notBefore.getTime() - NOW.getTime();
    };
    expect(at(0)).toBe(5_000);
    expect(at(1)).toBe(5_000 + 5_000 * JITTER_RATIO);
    expect(at(0.5)).toBeGreaterThan(at(0));
    expect(at(1)).toBeLessThanOrEqual(5_000 * (1 + JITTER_RATIO));
  });

  it('lengthens the delay at each attempt: 5 s, 30 s, 5 min', () => {
    const delays = [0, 1, 2].map((attempt) => {
      const route = routeFailure(new Error('locked'), attempt, NOW, () => 0);
      if (route.kind !== 'retry') throw new Error('expected a retry');
      return route.notBefore.getTime() - NOW.getTime();
    });
    expect(delays).toEqual([...RETRY_DELAYS_MS]);
  });

  it('dead-letters once the attempts are exhausted, and says which reason', () => {
    // `exhausted` and `permanent` both end in the same topic and mean opposite
    // things: one is a dependency that never came back, the other a message
    // that was never going to work. The reason is what tells them apart later.
    expect(routeFailure(new Error('still down'), RETRY_DELAYS_MS.length, NOW)).toEqual({
      kind: 'dlq',
      reason: 'exhausted',
    });
  });

  it('treats an UNRECOGNISED failure as transient, not as permanent', () => {
    // The asymmetry is deliberate: retrying a permanent failure costs three
    // attempts, discarding a transient one loses the fact for good.
    const route = routeFailure({ weird: true }, 0, NOW);
    expect(route.kind).toBe('retry');
  });

  it('names one retry and one dead-letter topic per context, never shared', () => {
    expect(retryTopic('notifications')).toBe('arthome.notifications.retry');
    expect(deadLetterTopic('notifications')).toBe('arthome.notifications.dlq');
    expect(retryTopic('catalog')).not.toBe(retryTopic('notifications'));
  });
});

describe('the retry schedule', () => {
  it('doubles from the first delay up to its cap, until the delays add up to the total', () => {
    expect(doublingDelays(1_000, 4_000, 15_000)).toEqual([1_000, 2_000, 4_000, 4_000, 4_000]);
  });

  it('spreads each attempt by up to JITTER_RATIO of its delay, and gives up after the last', () => {
    const delays = [1_000, 2_000];
    expect(nextAttemptAt(1, 0, delays, () => 0)).toEqual(new Date(1_000));
    expect(nextAttemptAt(2, 0, delays, () => 0.5)).toEqual(
      new Date(2_000 * (1 + JITTER_RATIO / 2)),
    );
    expect(nextAttemptAt(3, 0, delays)).toBeNull();
    expect(attemptsAllowedBy(delays)).toBe(3);
  });

  it('gives the jittered wait alone, the one a queue backs off by, and null after the last', () => {
    const delays = [1_000, 2_000];
    expect(retryDelayAfter(1, delays, () => 0)).toBe(1_000);
    expect(retryDelayAfter(2, delays, () => 1)).toBe(2_000 * (1 + JITTER_RATIO));
    expect(retryDelayAfter(2, delays, () => 0.5)).toBe(
      nextAttemptAt(2, 0, delays, () => 0.5)?.getTime(),
    );
    expect(retryDelayAfter(3, delays)).toBeNull();
    expect(retryDelayAfter(0, delays)).toBeNull();
  });
});
