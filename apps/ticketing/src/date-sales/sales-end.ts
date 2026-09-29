import type { Instant } from '@arthome/core';

/**
 * When a date's seats stop being sold, the one place the rule lives. None states it yet: core's
 *   `decideWatch` offers `buy_seat` through the live and, for some replay policies, the replay, and
 *   no document says when ticketing stops selling (HANDOVER §3, asked of "main"). Until one does,
 *   no sale ends by time: the closing pass exists and finds nothing.
 */
export function salesEndOf(_startsAt: Instant): Instant | null {
  return null;
}
