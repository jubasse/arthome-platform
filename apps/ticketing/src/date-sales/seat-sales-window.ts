import { isBefore, minutesBetween, plusMinutes, type Instant } from '@arthome/core';

/**
 * D-089's rules, held here under the names core will give them (HANDOVER §3). A seat covers the live
 *   alone, sold until this long after its start, the same for every channel.
 */
export const SEAT_SALES_CUTOFF_MINUTES_AFTER_START = 30;

export function seatSalesEndAt(startsAt: Instant): Instant {
  return plusMinutes(startsAt, SEAT_SALES_CUTOFF_MINUTES_AFTER_START);
}

/** Past the sale's end by time; a date with no start has no end. */
export function salesEndedBy(salesEndAt: Instant | null, now: Instant): boolean {
  return salesEndAt !== null && !isBefore(now, salesEndAt);
}

/** What a buyer arriving after the start is told, and must acknowledge, before buying. */
export interface LateEntry {
  readonly startedAt: Instant;
  /** Whole minutes of the live already missed. */
  readonly minutesElapsed: number;
  readonly salesEndAt: Instant;
}

/** Null before the start, and for a date with none. */
export function lateEntryOf(startsAt: Instant | null, now: Instant): LateEntry | null {
  if (startsAt === null || isBefore(now, startsAt)) return null;
  return {
    startedAt: startsAt,
    minutesElapsed: Math.floor(minutesBetween(startsAt, now)),
    salesEndAt: seatSalesEndAt(startsAt),
  };
}
