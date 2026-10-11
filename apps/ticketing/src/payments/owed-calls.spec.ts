import { JITTER_RATIO, RETRY_DELAYS_MS, retryDelayAfter } from '@arthome-platform/messaging';
import { describe, expect, it } from 'vitest';

import {
  INTENT_CANCEL_RETRY_DELAYS_MS,
  PROVIDER_KEY_RETENTION_MS,
  REFUND_FIRST_RETRY_DELAY_MS,
  REFUND_RETRIES_WITHIN_MS,
  REFUND_RETRY_DELAYS_MS,
  REFUND_RETRY_DELAY_CAP_MS,
} from './owed-calls.js';

const total = (delays: readonly number[]): number => delays.reduce((sum, delay) => sum + delay, 0);

describe("an owed refund's schedule", () => {
  it('doubles from its first delay up to its cap', () => {
    expect(REFUND_RETRY_DELAYS_MS.slice(0, 4)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(REFUND_RETRY_DELAYS_MS[0]).toBe(REFUND_FIRST_RETRY_DELAY_MS);
    expect(REFUND_RETRY_DELAYS_MS.at(-1)).toBe(REFUND_RETRY_DELAY_CAP_MS);
  });

  it("lands its last attempt, the jitter at its widest, under the cap, inside the provider's key", () => {
    const lastAttemptAtMost = REFUND_RETRY_DELAYS_MS.reduce(
      (elapsed, _, index) =>
        elapsed + (retryDelayAfter(index + 1, REFUND_RETRY_DELAYS_MS, () => 0.999_999) ?? 0),
      0,
    );

    expect(lastAttemptAtMost).toBeLessThan(REFUND_RETRIES_WITHIN_MS);
    expect(total(REFUND_RETRY_DELAYS_MS) * (1 + JITTER_RATIO)).toBeLessThan(
      REFUND_RETRIES_WITHIN_MS,
    );
    expect(REFUND_RETRIES_WITHIN_MS).toBeLessThan(PROVIDER_KEY_RETENTION_MS);
  });

  it('still outlasts a provider outage of hours: 28 attempts over 18.4 hours', () => {
    expect(total(REFUND_RETRY_DELAYS_MS)).toBeGreaterThan(18 * REFUND_RETRY_DELAY_CAP_MS);
    expect(REFUND_RETRY_DELAYS_MS).toHaveLength(27);
  });
});

describe("an intent's cancellation, best effort", () => {
  it("keeps the consumers' bound", () => {
    expect(INTENT_CANCEL_RETRY_DELAYS_MS).toEqual(RETRY_DELAYS_MS);
  });
});
