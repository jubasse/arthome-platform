import { JITTER_RATIO, RETRY_DELAYS_MS } from '@arthome-platform/messaging';
import { describe, expect, it } from 'vitest';

import {
  OWED_INTENT_CANCELLATION,
  OWED_REFUND,
  REFUND_FIRST_RETRY_DELAY_MS,
  REFUND_GIVE_UP_AFTER_MS,
  REFUND_RETRY_DELAYS_MS,
  REFUND_RETRY_DELAY_CAP_MS,
  attemptsMaxOf,
  nextAttemptAt,
} from './owed-calls.js';

const total = (delays: readonly number[]): number => delays.reduce((sum, delay) => sum + delay, 0);

describe("an owed refund's schedule", () => {
  it('doubles from its first delay up to its cap', () => {
    expect(REFUND_RETRY_DELAYS_MS.slice(0, 4)).toEqual([5_000, 10_000, 20_000, 40_000]);
    REFUND_RETRY_DELAYS_MS.slice(1).forEach((delay, index) => {
      const before = REFUND_RETRY_DELAYS_MS[index] ?? 0;
      expect(delay).toBe(Math.min(before * 2, REFUND_RETRY_DELAY_CAP_MS));
    });
    expect(REFUND_RETRY_DELAYS_MS[0]).toBe(REFUND_FIRST_RETRY_DELAY_MS);
    expect(REFUND_RETRY_DELAYS_MS.at(-1)).toBe(REFUND_RETRY_DELAY_CAP_MS);
  });

  it('outlasts a provider outage of hours, and is given up on after about a day', () => {
    const upToTheLast = total(REFUND_RETRY_DELAYS_MS);
    expect(upToTheLast).toBeGreaterThanOrEqual(REFUND_GIVE_UP_AFTER_MS);
    expect(upToTheLast).toBeLessThan(REFUND_GIVE_UP_AFTER_MS + REFUND_RETRY_DELAY_CAP_MS);
    expect(attemptsMaxOf(OWED_REFUND)).toBe(REFUND_RETRY_DELAYS_MS.length + 1);
  });

  it('keeps the jitter of the consumers', () => {
    const now = 0;
    const eighth = REFUND_RETRY_DELAYS_MS[7] ?? 0;
    const at = nextAttemptAt(8, now, REFUND_RETRY_DELAYS_MS)?.getTime() ?? -1;
    expect(at).toBeGreaterThanOrEqual(eighth);
    expect(at).toBeLessThan(eighth * (1 + JITTER_RATIO));
    expect(nextAttemptAt(attemptsMaxOf(OWED_REFUND), now, REFUND_RETRY_DELAYS_MS)).toBeNull();
  });
});

describe("an intent's cancellation, best effort", () => {
  it("keeps the consumers' bound", () => {
    expect(OWED_INTENT_CANCELLATION.retryDelaysMs).toEqual(RETRY_DELAYS_MS);
    expect(attemptsMaxOf(OWED_INTENT_CANCELLATION)).toBe(RETRY_DELAYS_MS.length + 1);
  });
});
