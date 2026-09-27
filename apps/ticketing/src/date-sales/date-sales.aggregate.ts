import { AggregateRoot } from '@nestjs/cqrs';
import { v7 as uuidv7 } from 'uuid';

import {
  CatalogErrorCode,
  DateOutcome,
  DomainError,
  DomainErrorCode,
  assertTierWidens,
  isBefore,
  type Instant,
  type TierPrice,
} from '@arthome/core';

import {
  CapacityTierOpened,
  DateOutcomeRecorded,
  DatePricesLocked,
  DatePricesSet,
  DateSalesOpened,
  DateScheduleRecorded,
  type CapacityTier,
  type DateSalesEvent,
} from './date-sales.events.js';
import { technicalProvisionOf } from './technical-provision.js';

export interface DateSalesSnapshot {
  readonly dateId: string;
  readonly channelId: string;
  readonly capacityTotal: number;
  readonly capacityTiers: readonly CapacityTier[];
  /**
   * The three counters as loaded. The repository writes each as a delta from what it read, never
   *   as a value: the hot decrement (adr-ticketing.md §3) moves them without the version.
   */
  readonly seatsAvailable: number;
  readonly seatsSold: number;
  readonly waitlistCount: number;
  readonly priceTiers: readonly TierPrice[];
  /** When `catalog.publication.engaged` opened the sale: the prices hold from then on. */
  readonly pricesLockedAt: Instant | null;
  readonly salesClosedAt: Instant | null;
  readonly startsAt: Instant | null;
  /** The `occurred_at` of the schedule fact applied last, which an older one may not overwrite. */
  readonly scheduleStatedAt: Instant | null;
  readonly outcome: DateOutcome | null;
  readonly outcomeStatedAt: Instant | null;
  readonly version: number;
}

const OUTCOMES_CLOSING_SALES: readonly DateOutcome[] = [
  DateOutcome.CANCELLED,
  DateOutcome.INTERRUPTED,
];

/** Deeply, so that a nested array written in place throws as well. */
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) frozen(inner);
  }
  return value;
}

/** An older fact never overwrites a newer one; one stated at the same instant applies again. */
function isStale(statedAt: Instant, lastStatedAt: Instant | null): boolean {
  return lastStatedAt !== null && isBefore(statedAt, lastStatedAt);
}

/**
 * data-model.md §3.1's `DateSales`, a date's commercial face. Its studio commands name the
 *   version they read; the facts consumed from catalog are guarded by their `occurred_at` instead,
 *   and move the version all the same, since each changes what the pane shows. Every event it
 *   applies is stated at ticketing's `now`, never at catalog's instant: one clock per stream, so a
 *   skew between the two services cannot make a consumer take a later event for an older one.
 */
export class DateSales extends AggregateRoot<DateSalesEvent> {
  private current: DateSalesSnapshot;

  private constructor(current: DateSalesSnapshot) {
    super();
    this.current = frozen(current);
  }

  public static restore(snapshot: DateSalesSnapshot): DateSales {
    return new DateSales(snapshot);
  }

  /** Empty: capacity and prices are the studio's, the start catalog's once scheduled. */
  public static open(dateId: string, channelId: string, now: Instant): DateSales {
    const sales = new DateSales({
      dateId,
      channelId,
      capacityTotal: 0,
      capacityTiers: [],
      seatsAvailable: 0,
      seatsSold: 0,
      waitlistCount: 0,
      priceTiers: [],
      pricesLockedAt: null,
      salesClosedAt: null,
      startsAt: null,
      scheduleStatedAt: null,
      outcome: null,
      outcomeStatedAt: null,
      version: 1,
    });
    sales.apply(new DateSalesOpened(dateId, channelId, now));
    return sales;
  }

  public get snapshot(): DateSalesSnapshot {
    return this.current;
  }

  /** Replaces every tier, until the sale opens: `date.prices_locked` from then, naming when. */
  public setPrices(expectedVersion: number, tiers: readonly TierPrice[], now: Instant): void {
    const version = this.advancedFrom(expectedVersion);
    const { dateId, channelId, pricesLockedAt } = this.current;
    if (pricesLockedAt !== null) {
      throw new DomainError({
        code: CatalogErrorCode.PRICES_LOCKED,
        params: { lockedAt: pricesLockedAt },
      });
    }
    this.current = frozen({ ...this.current, priceTiers: tiers, version });
    this.apply(new DatePricesSet(dateId, channelId, tiers, now));
  }

  /**
   * Widens the capacity by one tier, the first included, and the seats available with it; a sale
   *   an outcome closed is refused, naming it. The waiting list's notification is T5's: nothing is
   *   recorded for it yet.
   */
  public openCapacityTier(expectedVersion: number, additionalCapacity: number, now: Instant): void {
    const version = this.advancedFrom(expectedVersion);
    const { dateId, channelId, capacityTotal, capacityTiers, seatsAvailable, startsAt } =
      this.current;
    const { salesClosedAt, outcome } = this.current;
    if (salesClosedAt !== null && outcome !== null) {
      throw new DomainError({
        code: DomainErrorCode.STATE_CONFLICT,
        params: { version: expectedVersion, outcome },
      });
    }
    const widened = capacityTotal + additionalCapacity;
    assertTierWidens(capacityTotal, widened);
    const tier: CapacityTier = { id: uuidv7(), capacity: additionalCapacity, openedAt: now };
    this.current = frozen({
      ...this.current,
      capacityTotal: widened,
      capacityTiers: [...capacityTiers, tier],
      seatsAvailable: seatsAvailable + additionalCapacity,
      version,
    });
    this.apply(
      new CapacityTierOpened(
        dateId,
        channelId,
        tier,
        widened,
        technicalProvisionOf(widened, startsAt),
        now,
      ),
    );
  }

  /** False when already locked: publishing engages once. */
  public lockPrices(engagedAt: Instant, now: Instant): boolean {
    const { dateId, channelId, pricesLockedAt, priceTiers, version } = this.current;
    if (pricesLockedAt !== null) return false;
    this.current = frozen({ ...this.current, pricesLockedAt: engagedAt, version: version + 1 });
    this.apply(new DatePricesLocked(dateId, channelId, priceTiers, now));
    return true;
  }

  /** A start as scheduled or moved by a postponement; false when a newer one was recorded. */
  public recordSchedule(startsAt: Instant, statedAt: Instant, now: Instant): boolean {
    const { dateId, channelId, capacityTotal, scheduleStatedAt, version } = this.current;
    if (isStale(statedAt, scheduleStatedAt)) return false;
    this.current = frozen({
      ...this.current,
      startsAt,
      scheduleStatedAt: statedAt,
      version: version + 1,
    });
    this.apply(
      new DateScheduleRecorded(
        dateId,
        channelId,
        startsAt,
        capacityTotal,
        technicalProvisionOf(capacityTotal, startsAt),
        now,
      ),
    );
    return true;
  }

  /**
   * The date's outcome as catalog declared it; false when a newer one was recorded. A cancellation
   *   or an interruption closes the sale for good; its refunds and credits are T4's.
   */
  public recordOutcome(outcome: DateOutcome, statedAt: Instant, now: Instant): boolean {
    const { dateId, channelId, outcomeStatedAt, salesClosedAt, version } = this.current;
    if (isStale(statedAt, outcomeStatedAt)) return false;
    const closes = OUTCOMES_CLOSING_SALES.includes(outcome);
    this.current = frozen({
      ...this.current,
      outcome,
      outcomeStatedAt: statedAt,
      salesClosedAt: closes ? (salesClosedAt ?? statedAt) : salesClosedAt,
      version: version + 1,
    });
    this.apply(new DateOutcomeRecorded(dateId, channelId, outcome, closes, now));
    return true;
  }

  /** Refuses a screen that read another version, naming the current one; else the next version. */
  private advancedFrom(expectedVersion: number): number {
    const { version } = this.current;
    if (version !== expectedVersion) {
      throw new DomainError({ code: DomainErrorCode.STATE_CONFLICT, params: { version } });
    }
    return version + 1;
  }
}
