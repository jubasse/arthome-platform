import { RETRY_DELAYS_MS, doublingDelays } from '@arthome-platform/messaging';
import { describe, expect, it } from 'vitest';

import {
  INTENT_CANCEL_RETRY_DELAYS_MS,
  REFUND_FIRST_RETRY_DELAY_MS,
  REFUND_GIVE_UP_AFTER_MS,
  REFUND_RETRY_DELAYS_MS,
  REFUND_RETRY_DELAY_CAP_MS,
} from './owed-calls.js';

const total = (delays: readonly number[]): number => delays.reduce((sum, delay) => sum + delay, 0);

describe("an owed refund's schedule", () => {
  it('doubles from its first delay up to its cap', () => {
    expect(REFUND_RETRY_DELAYS_MS.slice(0, 4)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(REFUND_RETRY_DELAYS_MS).toEqual(
      doublingDelays(
        REFUND_FIRST_RETRY_DELAY_MS,
        REFUND_RETRY_DELAY_CAP_MS,
        REFUND_GIVE_UP_AFTER_MS,
      ),
    );
    expect(REFUND_RETRY_DELAYS_MS.at(-1)).toBe(REFUND_RETRY_DELAY_CAP_MS);
  });

  it('outlasts a provider outage of hours, and is given up on after about a day', () => {
    const upToTheLast = total(REFUND_RETRY_DELAYS_MS);
    expect(upToTheLast).toBeGreaterThanOrEqual(REFUND_GIVE_UP_AFTER_MS);
    expect(upToTheLast).toBeLessThan(REFUND_GIVE_UP_AFTER_MS + REFUND_RETRY_DELAY_CAP_MS);
    expect(REFUND_RETRY_DELAYS_MS).toHaveLength(33);
  });
});

describe("an intent's cancellation, best effort", () => {
  it("keeps the consumers' bound", () => {
    expect(INTENT_CANCEL_RETRY_DELAYS_MS).toEqual(RETRY_DELAYS_MS);
  });
});
