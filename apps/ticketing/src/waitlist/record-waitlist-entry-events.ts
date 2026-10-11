import type { EntityManager } from 'typeorm';

import { WaitlistEntryState } from '@arthome/core';

import type { WaitlistEntryEvent } from './waitlist-entry.events.js';
import { writeWaitlistNotified } from './waitlist-notified.js';
import { assertNever } from '../assert-never.js';

/** An account joining into an open window is named by a `waitlist.notified` of its own. */
export async function recordWaitlistEntryEvents(
  manager: EntityManager,
  events: readonly WaitlistEntryEvent[],
  traceparent: string | null,
): Promise<void> {
  for (const event of events) {
    switch (event.kind) {
      case 'WaitlistJoined':
        if (event.state === WaitlistEntryState.NOTIFIED && event.priorityUntil !== null) {
          await writeWaitlistNotified(
            manager,
            {
              dateId: event.dateId,
              accountIds: [event.accountId],
              priorityUntil: event.priorityUntil,
            },
            event.occurredAt,
            traceparent,
          );
        }
        break;
      case 'WaitlistLeft':
        break;
      default:
        assertNever(event);
    }
  }
}
