import { frozen } from '@arthome-platform/transactions';
import { AggregateRoot } from '@nestjs/cqrs';
import { v7 as uuidv7 } from 'uuid';

import {
  CatalogErrorCode,
  DateOutcome,
  DomainError,
  DomainErrorCode,
  assertPricesShareCurrency,
  assertTechnicalProvisionCovers,
  assertTechnicalProvisionRecordable,
  assertTierWidens,
  isBefore,
  type Instant,
  type PriceTier,
  type TierPrice,
} from '@arthome/core';

import {
  CapacityTierOpened,
  DateOutcomeRecorded,
  DatePricesLocked,
  DatePricesSet,
  DateSalesEnded,
  DateSalesOpened,
  DateSalesReopened,
  DateScheduleRecorded,
  SeatsHeld,
  TechnicalProvisionSet,
  type CapacityTier,
  type DateSalesEvent,
} from './date-sales.events.js';
import { seatQuoteOf, type SeatQuote } from './seat-quote.js';
import { lateEntryOf, seatSalesEndAt, type LateEntry } from './seat-sales-window.js';
import { technicalProvisionOf } from './technical-provision.js';

export interface DateSalesSnapshot {
  readonly dateId: string;
  readonly channelId: string;
  readonly capacityTotal: number;
  /** The capacity the recorded technical provision covers; null while none is (D-088). */
  readonly provisionedCapacity: number | null;
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
  /** When the sale ends by time, from the start (`seatSalesEndAt`, D-089); null with no start. */
  readonly salesEndAt: Instant | null;
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
      provisionedCapacity: null,
      capacityTiers: [],
      seatsAvailable: 0,
      seatsSold: 0,
      waitlistCount: 0,
      priceTiers: [],
      pricesLockedAt: null,
      salesClosedAt: null,
      salesEndAt: null,
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

  /** From the lock of its prices until an outcome closes it: `on_sale`, as the row generates it. */
  public get isOnSale(): boolean {
    const { pricesLockedAt, salesClosedAt } = this.current;
    return pricesLockedAt !== null && salesClosedAt === null;
  }

  /**
   * On sale and short of its end by time. Read without the row's lock on a purchase, so the hold's
   *   statement checks the end again.
   */
  public sellsSeatsAt(now: Instant): boolean {
    const { salesEndAt } = this.current;
    return this.isOnSale && (salesEndAt === null || isBefore(now, salesEndAt));
  }

  /** What a buyer arriving now must be told and acknowledge; null before the start. */
  public lateEntryAt(now: Instant): LateEntry | null {
    return lateEntryOf(this.current.startsAt, now);
  }

  /** The price of `quantity` seats of `tier`; null while that tier is not sold. */
  public quote(tier: PriceTier, quantity: number): SeatQuote | null {
    return seatQuoteOf(this.current.priceTiers, tier, quantity);
  }

  /**
   * Decides a hold of `quantity` seats, which the repository's conditional decrement then takes, or
   *   refuses when fewer are left (adr-ticketing.md §11). Loaded without the row's lock, so this
   *   counter is only what a later save measures its delta from: the statement's WHERE is the rule.
   *   The version stays as loaded.
   */
  public holdSeats(quantity: number, now: Instant): void {
    const { dateId, seatsAvailable } = this.current;
    this.current = frozen({ ...this.current, seatsAvailable: seatsAvailable - quantity });
    this.apply(new SeatsHeld(dateId, quantity, now));
  }

  /**
   * Replaces every tier, in one currency, until the sale opens: `date.prices_locked` from then,
   *   naming when.
   */
  public setPrices(expectedVersion: number, tiers: readonly TierPrice[], now: Instant): void {
    const version = this.advancedFrom(expectedVersion);
    const { dateId, channelId, pricesLockedAt } = this.current;
    if (pricesLockedAt !== null) {
      throw new DomainError({
        code: CatalogErrorCode.PRICES_LOCKED,
        params: { lockedAt: pricesLockedAt },
      });
    }
    assertPricesShareCurrency(tiers);
    this.current = frozen({ ...this.current, priceTiers: structuredClone(tiers), version });
    this.apply(new DatePricesSet(dateId, channelId, tiers, now));
  }

  /**
   * Widens the capacity by one tier, the first included, and the seats available with it; a sale
   *   an outcome closed is refused, naming it, and so is a capacity past core's threshold that the
   *   recorded provision does not cover. The waiting list's notification is T5's: nothing is
   *   recorded for it yet.
   */
  public openCapacityTier(expectedVersion: number, additionalCapacity: number, now: Instant): void {
    const version = this.advancedFrom(expectedVersion);
    const { dateId, channelId, capacityTotal, capacityTiers, seatsAvailable, startsAt } =
      this.current;
    const { provisionedCapacity, salesClosedAt, outcome } = this.current;
    if (salesClosedAt !== null && outcome !== null) {
      throw new DomainError({
        code: DomainErrorCode.STATE_CONFLICT,
        params: { version: expectedVersion, outcome },
      });
    }
    const widened = capacityTotal + additionalCapacity;
    assertTierWidens(capacityTotal, widened);
    assertTechnicalProvisionCovers(widened, provisionedCapacity, startsAt);
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
        technicalProvisionOf(widened, provisionedCapacity, startsAt),
        now,
      ),
    );
  }

  /**
   * Records or revises the capacity the infrastructure is provisioned for, until core's revision
   *   deadline and never below the capacity already open (D-088).
   */
  public setTechnicalProvision(
    expectedVersion: number,
    provisionedCapacity: number,
    now: Instant,
  ): void {
    const version = this.advancedFrom(expectedVersion);
    const { dateId, channelId, capacityTotal, startsAt } = this.current;
    assertTechnicalProvisionRecordable(capacityTotal, provisionedCapacity, startsAt, now);
    this.current = frozen({ ...this.current, provisionedCapacity, version });
    this.apply(
      new TechnicalProvisionSet(
        dateId,
        channelId,
        capacityTotal,
        technicalProvisionOf(capacityTotal, provisionedCapacity, startsAt),
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

  /**
   * A start as scheduled or moved by a postponement, its end of sales with it; false when a newer
   *   one was recorded. A sale closed by time whose new end is still ahead reopens: core refuses a
   *   postponement once the live started, so only a fact applied late, after the consumer lagged,
   *   finds its sale already closed.
   */
  public recordSchedule(startsAt: Instant, statedAt: Instant, now: Instant): boolean {
    const { dateId, channelId, capacityTotal, provisionedCapacity, scheduleStatedAt, version } =
      this.current;
    if (isStale(statedAt, scheduleStatedAt)) return false;
    const salesEndAt = seatSalesEndAt(startsAt);
    const reopens = this.closedByTime && isBefore(now, salesEndAt);
    this.current = frozen({
      ...this.current,
      startsAt,
      salesEndAt,
      salesClosedAt: reopens ? null : this.current.salesClosedAt,
      scheduleStatedAt: statedAt,
      version: version + 1,
    });
    this.apply(
      new DateScheduleRecorded(
        dateId,
        channelId,
        startsAt,
        capacityTotal,
        technicalProvisionOf(capacityTotal, provisionedCapacity, startsAt),
        now,
      ),
    );
    if (reopens) this.apply(new DateSalesReopened(dateId, channelId, now));
    return true;
  }

  /** Closed at its end by time, and by no outcome: a cancellation or an interruption is final. */
  private get closedByTime(): boolean {
    const { salesClosedAt, outcome } = this.current;
    return (
      salesClosedAt !== null && (outcome === null || !OUTCOMES_CLOSING_SALES.includes(outcome))
    );
  }

  /**
   * Ends a sale on sale once its end by time has passed (`salesEndAt`); false otherwise. It closes
   *   as an outcome closes it, at the instant it ended, publishing a last availability.
   */
  public endSales(now: Instant): boolean {
    const { dateId, channelId, salesEndAt, version } = this.current;
    if (!this.isOnSale || salesEndAt === null || isBefore(now, salesEndAt)) return false;
    this.current = frozen({ ...this.current, salesClosedAt: salesEndAt, version: version + 1 });
    this.apply(new DateSalesEnded(dateId, channelId, salesEndAt, now));
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
