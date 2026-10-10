import { WAITLIST_PRIORITY_HOURS, type Instant, type WaitlistEntryState } from '@arthome/core';

import { inPriorityWindow } from './priority-pool.js';
import { isOnWaitlist } from './waitlist-entry.aggregate.js';

/**
 * storefront.yaml's `WaitlistRegistration` but its `date`, which the BFF adds (T7): no rank, ever
 *   (D-083), and the window and the pool's seats left only while the caller is notified into it.
 */
export interface WaitlistRegistrationView {
  readonly joined: boolean;
  readonly state: WaitlistEntryState | null;
  readonly rankDisclosed: false;
  readonly rank: null;
  readonly priorityWindowHours: number;
  readonly priorityUntil: Instant | null;
  readonly priorityPoolSeats?: number;
}

export interface PriorityPool {
  readonly priorityUntil: Instant | null;
  readonly priorityPoolSeats: number;
}

export function waitlistRegistrationOf(
  state: WaitlistEntryState | null,
  { priorityUntil, priorityPoolSeats }: PriorityPool,
  now: Instant,
): WaitlistRegistrationView {
  const inWindow = inPriorityWindow(state, priorityUntil, now);
  return {
    joined: isOnWaitlist(state),
    state,
    rankDisclosed: false,
    rank: null,
    priorityWindowHours: WAITLIST_PRIORITY_HOURS,
    priorityUntil: inWindow ? priorityUntil : null,
    ...(inWindow && { priorityPoolSeats }),
  };
}
