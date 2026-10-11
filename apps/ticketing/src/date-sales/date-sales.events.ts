import type { IEvent } from '@nestjs/cqrs';

import type { DateOutcome, Instant, TierPrice } from '@arthome/core';

import type { TechnicalProvision } from './technical-provision.js';

export interface CapacityTier {
  readonly id: string;
  readonly capacity: number;
  readonly openedAt: Instant;
}

/** `catalog.date.drafted` read: the date has a commercial face, empty until the studio fills it. */
export class DateSalesOpened implements IEvent {
  public readonly kind = 'DateSalesOpened';

  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly occurredAt: Instant,
  ) {}
}

export class DatePricesSet implements IEvent {
  public readonly kind = 'DatePricesSet';

  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly tiers: readonly TierPrice[],
    public readonly occurredAt: Instant,
  ) {}
}

/** `catalog.publication.engaged` read: the box office opened, and its prices hold from then on. */
export class DatePricesLocked implements IEvent {
  public readonly kind = 'DatePricesLocked';

  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly tiers: readonly TierPrice[],
    public readonly occurredAt: Instant,
  ) {}
}

export class CapacityTierOpened implements IEvent {
  public readonly kind = 'CapacityTierOpened';

  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly tier: CapacityTier,
    public readonly capacityTotal: number,
    public readonly provision: TechnicalProvision,
    public readonly occurredAt: Instant,
  ) {}
}

/** The capacity the infrastructure is provisioned for, recorded or revised by the studio (D-088). */
export class TechnicalProvisionSet implements IEvent {
  public readonly kind = 'TechnicalProvisionSet';

  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly capacityTotal: number,
    public readonly provision: TechnicalProvision,
    public readonly occurredAt: Instant,
  ) {}
}

/** The date's start as catalog last stated it, scheduled or moved: the provision counts back from it. */
export class DateScheduleRecorded implements IEvent {
  public readonly kind = 'DateScheduleRecorded';

  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly startsAt: Instant,
    public readonly capacityTotal: number,
    public readonly provision: TechnicalProvision,
    public readonly occurredAt: Instant,
  ) {}
}

export class DateOutcomeRecorded implements IEvent {
  public readonly kind = 'DateOutcomeRecorded';

  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly outcome: DateOutcome,
    /** A cancellation or an interruption ends the sale (adr-ticketing.md §8). */
    public readonly salesClosed: boolean,
    public readonly occurredAt: Instant,
  ) {}
}

/** Its end by time passed: the sale closed, with no outcome declared. */
export class DateSalesEnded implements IEvent {
  public readonly kind = 'DateSalesEnded';

  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly endedAt: Instant,
    public readonly occurredAt: Instant,
  ) {}
}

/** A sale closed by time, reopened by a postponement applied after its old end. */
export class DateSalesReopened implements IEvent {
  public readonly kind = 'DateSalesReopened';

  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly occurredAt: Instant,
  ) {}
}

/**
 * Seats left `seats_available` for a hold, in the conditional statement that decided they could
 *   (adr-ticketing.md §3). The statement counts the move; nothing reaches the wire from here.
 */
export class SeatsHeld implements IEvent {
  public readonly kind = 'SeatsHeld';

  public constructor(
    public readonly dateId: string,
    public readonly quantity: number,
    public readonly occurredAt: Instant,
  ) {}
}

/** A tier set aside for the waiting list notified with it, until `priorityUntil` (D-083). */
export class PriorityWindowOpened implements IEvent {
  public readonly kind = 'PriorityWindowOpened';

  public constructor(
    public readonly dateId: string,
    public readonly poolSeats: number,
    public readonly priorityUntil: Instant,
    public readonly occurredAt: Instant,
  ) {}
}

/**
 * Every event of the aggregate. A mapping switches on `kind` and ends in `assertNever`, so an
 *   event without its case fails to compile rather than reach the wire as another.
 */
export type DateSalesEvent =
  | DateSalesOpened
  | DatePricesSet
  | DatePricesLocked
  | CapacityTierOpened
  | TechnicalProvisionSet
  | DateScheduleRecorded
  | DateOutcomeRecorded
  | DateSalesEnded
  | DateSalesReopened
  | SeatsHeld
  | PriorityWindowOpened;
