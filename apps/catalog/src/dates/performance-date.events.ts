import type { IEvent } from '@nestjs/cqrs';

import type {
  DateOutcome,
  Instant,
  PublicationState,
  ReplayPolicy,
  TerritoryRights,
} from '@arthome/core';

/** The run desk's message: content, in the language it was written in. */
export interface OutcomeMessage {
  readonly contentLanguage: string;
  readonly text: string;
}

export class DateDrafted implements IEvent {
  public readonly kind = 'DateDrafted';

  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly showId: string,
    public readonly venueId: string,
    public readonly occurredAt: Instant,
  ) {}
}

/** What a date states once public, and all its `DateScheduled` carries. */
export interface PublicDateFacts {
  readonly dateId: string;
  readonly channelId: string;
  readonly showId: string;
  readonly venueId: string;
  readonly startsAt: Instant;
  readonly runtimeMin: number;
  readonly replayPolicy: ReplayPolicy;
  readonly replayWindowHours: number | null;
  readonly rights: TerritoryRights;
  readonly slug: string;
}

/** Its publication made the date public: its slug set, its running time frozen (§2.2, §2.7). */
export class DateScheduled implements IEvent {
  public readonly kind = 'DateScheduled';

  public constructor(
    public readonly facts: PublicDateFacts,
    public readonly occurredAt: Instant,
  ) {}

  public get dateId(): string {
    return this.facts.dateId;
  }
}

export class DateOutcomeDeclared implements IEvent {
  public readonly kind = 'DateOutcomeDeclared';

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
  public readonly kind = 'DateRescheduled';

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

export class PublicationStateChanged implements IEvent {
  public readonly kind = 'PublicationStateChanged';

  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly from: PublicationState,
    public readonly to: PublicationState,
    /** The version the change produced. */
    public readonly version: number,
    /** A one-way transition: the way back is refused from now on. */
    public readonly irreversible: boolean,
    public readonly occurredAt: Instant,
  ) {}
}

/** Publishing commits the displayed prices, the replay and the chat mode. */
export class PublicationEngaged implements IEvent {
  public readonly kind = 'PublicationEngaged';

  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly occurredAt: Instant,
  ) {}
}

/**
 * Every event of the aggregate: the date's own and its publication's, all keyed by the date. A
 *   mapping switches on `kind` and ends in `assertNever`, so an event without its case fails to
 *   compile rather than reach the wire as another.
 */
export type PerformanceDateEvent =
  | DateDrafted
  | DateScheduled
  | DateOutcomeDeclared
  | DateRescheduled
  | PublicationStateChanged
  | PublicationEngaged;
