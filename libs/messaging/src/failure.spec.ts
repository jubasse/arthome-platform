import { describe, expect, it } from 'vitest';

import {
  JITTER_RATIO,
  PermanentError,
  RETRY_DELAYS_MS,
  deadLetterTopic,
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
