import { WaitlistNotifiedSchema } from '@arthome-platform/events';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { EntityManager } from 'typeorm';

import { WAITLIST_NOTIFIED_ACCOUNTS_MAX, type Instant } from '@arthome/core';

import { writeTicketingEvent } from '../ticketing-events.js';

/**
 * `waitlist.notified` on the date's key, one row per `WAITLIST_NOTIFIED_ACCOUNTS_MAX` accounts, in
 *   the order given; none for no account.
 */
export async function writeWaitlistNotified(
  manager: EntityManager,
  notice: {
    readonly dateId: string;
    readonly accountIds: readonly string[];
    readonly priorityUntil: Instant;
  },
  now: Instant,
  traceparent: string | null,
): Promise<void> {
  const { dateId, accountIds, priorityUntil } = notice;
  for (let start = 0; start < accountIds.length; start += WAITLIST_NOTIFIED_ACCOUNTS_MAX) {
    const payload = create(WaitlistNotifiedSchema, {
      dateId,
      accountIds: accountIds.slice(start, start + WAITLIST_NOTIFIED_ACCOUNTS_MAX),
      priorityUntil: timestampFromDate(new Date(priorityUntil)),
      occurredAt: timestampFromDate(new Date(now)),
    });
    await writeTicketingEvent(
      manager,
      {
        type: 'ticketing.waitlist.notified.v1',
        key: dateId,
        payload: toBinary(WaitlistNotifiedSchema, payload),
        traceparent,
      },
      new Date(now),
    );
  }
}
