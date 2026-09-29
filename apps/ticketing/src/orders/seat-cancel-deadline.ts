import { plusMinutes, type Instant } from '@arthome/core';

/** needs/storefront-web.md's "up to 1 h before the start", in no core constant yet (HANDOVER §3). */
const INTERIM_CANCEL_DEADLINE_MINUTES_BEFORE = 60;

export function interimSeatCancelDeadlineOf(startsAt: Instant | null): Instant | null {
  return startsAt === null ? null : plusMinutes(startsAt, -INTERIM_CANCEL_DEADLINE_MINUTES_BEFORE);
}
