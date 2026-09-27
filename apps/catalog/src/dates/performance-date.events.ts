import type { IEvent } from '@nestjs/cqrs';

import type { DateOutcome, Instant } from '@arthome/core';

/** The run desk's message: content, in the language it was written in. */
export interface OutcomeMessage {
  readonly contentLanguage: string;
  readonly text: string;
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

export type PerformanceDateEvent = DateOutcomeDeclared | DateRescheduled;
