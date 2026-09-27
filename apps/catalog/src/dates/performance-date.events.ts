import type { IEvent } from '@nestjs/cqrs';

import type { DateOutcome, Instant } from '@arthome/core';

import type { PerformanceDateSnapshot } from './performance-date.aggregate.js';

/** The run desk's message: content, in the language it was written in. */
export interface OutcomeMessage {
  readonly contentLanguage: string;
  readonly text: string;
}

export class DateDrafted implements IEvent {
  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly showId: string,
    public readonly venueId: string,
    public readonly occurredAt: Instant,
  ) {}
}

/** Its publication made the date public: its slug set, its running time frozen (§2.2, §2.7). */
export class DateScheduled implements IEvent {
  public constructor(
    /** Its public facts as they stand, which `DateScheduled` states on the wire. */
    public readonly date: PerformanceDateSnapshot & { readonly slug: string },
    public readonly occurredAt: Instant,
  ) {}

  public get dateId(): string {
    return this.date.id;
  }
}

export class DateOutcomeDeclared implements IEvent {
  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly outcome: DateOutcome,
    public readonly message: OutcomeMessage,
    /** Where a postponement moved the date; null for the two final outcomes. */
    public readonly rescheduledTo: Instant | null,
    public readonly occurredAt: Instant,
  ) {}
}

/** Follows `DateOutcomeDeclared` when a postponement moves the date (D-074). */
export class DateRescheduled implements IEvent {
  public constructor(
    public readonly dateId: string,
    public readonly showId: string,
    public readonly previousStartsAt: Instant,
    public readonly newStartsAt: Instant,
    public readonly previousSlug: string,
    public readonly newSlug: string,
    public readonly occurredAt: Instant,
  ) {}
}

export type PerformanceDateEvent =
  DateDrafted | DateScheduled | DateOutcomeDeclared | DateRescheduled;
