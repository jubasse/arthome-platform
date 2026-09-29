import type { Instant } from '@arthome/core';

/**
 * When a date's seats stop being sold. No document states it yet (HANDOVER §0l, asked of "main"),
 *   so no sale ends by time: the closing pass exists and finds nothing.
 */
export function salesEndOf(_startsAt: Instant): Instant | null {
  return null;
}
