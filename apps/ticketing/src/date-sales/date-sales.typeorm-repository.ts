import { AggregateTracker, saveVersioned, type Track } from '@arthome-platform/transactions';
import type { EntityManager } from 'typeorm';

import { money, type TierPrice } from '@arthome/core';

import { DateSales, type DateSalesSnapshot } from './date-sales.aggregate.js';
import { DateSalesRow, type PriceTierColumn } from './date-sales.entity.js';
import { DateSalesRepository } from './date-sales.repository.js';

type Counter = 'seats_available' | 'seats_sold' | 'waitlist_count';

type StateColumns = Omit<
  DateSalesRow,
  | 'date_id'
  | Counter
  | 'on_sale'
  | 'availability_dirty_since'
  | 'availability_published_at'
  | 'availability_published_sold_out'
  | 'created_at'
  | 'updated_at'
>;

export class TypeOrmDateSalesRepository extends DateSalesRepository {
  private readonly tracker: AggregateTracker<DateSales>;
  /** What the row held as last read or written, which each counter's delta is taken from. */
  private readonly storedSnapshots = new WeakMap<DateSales, DateSalesSnapshot>();

  public constructor(
    private readonly manager: EntityManager,
    track: Track,
  ) {
    super();
    this.tracker = new AggregateTracker(track);
  }

  public async findById(dateId: string): Promise<DateSales | null> {
    const row = await this.manager.findOne(DateSalesRow, {
      where: { date_id: dateId },
      lock: { mode: 'pessimistic_write' },
    });
    if (row === null) return null;
    const sales = DateSales.restore(dateSalesSnapshotOf(row));
    this.storedSnapshots.set(sales, sales.snapshot);
    return this.tracker.loaded(sales, row.version);
  }

  /**
   * The counters move by what the aggregate added since the load, `seats_available + n`: written
   *   as values, a hold committed between a load and a save without the row lock would be undone.
   */
  public async save(sales: DateSales): Promise<void> {
    const current = sales.snapshot;
    const loadedVersion = this.tracker.versionOf(sales);
    if (loadedVersion === undefined) {
      await this.manager.insert(DateSalesRow, {
        date_id: current.dateId,
        ...stateColumnsOf(current),
        seats_available: current.seatsAvailable,
        seats_sold: current.seatsSold,
        waitlist_count: current.waitlistCount,
      });
    } else {
      const stored = this.storedSnapshots.get(sales) ?? current;
      await saveVersioned(
        this.manager,
        DateSalesRow,
        { date_id: current.dateId },
        loadedVersion,
        {
          ...stateColumnsOf(current),
          seats_available: movedBy(
            'seats_available',
            current.seatsAvailable - stored.seatsAvailable,
          ),
          seats_sold: movedBy('seats_sold', current.seatsSold - stored.seatsSold),
          waitlist_count: movedBy('waitlist_count', current.waitlistCount - stored.waitlistCount),
        },
        ({ version }) => ({ version }),
      );
    }
    this.storedSnapshots.set(sales, current);
    this.tracker.written(sales, current.version);
  }
}

function movedBy(counter: Counter, delta: number): () => string {
  if (!Number.isSafeInteger(delta)) throw new Error(`${counter} moved by ${String(delta)}`);
  return () => `${counter} + ${String(delta)}`;
}

const dateOf = (instant: string | null): Date | null =>
  instant === null ? null : new Date(instant);

const instantOf = (date: Date | null): string | null => date?.toISOString() ?? null;

function tierPriceOf(column: PriceTierColumn): TierPrice {
  return {
    tier: column.tier,
    amount: money(column.amountMinor, column.currencyCode),
    active: column.active,
  };
}

export function dateSalesSnapshotOf(row: DateSalesRow): DateSalesSnapshot {
  return {
    dateId: row.date_id,
    channelId: row.channel_id,
    capacityTotal: row.capacity_total,
    capacityTiers: row.capacity_tiers.map(({ id, capacity, openedAt }) => ({
      id,
      capacity,
      openedAt,
    })),
    seatsAvailable: row.seats_available,
    seatsSold: row.seats_sold,
    waitlistCount: row.waitlist_count,
    priceTiers: row.price_tiers.map(tierPriceOf),
    pricesLockedAt: instantOf(row.prices_locked_at),
    salesClosedAt: instantOf(row.sales_closed_at),
    startsAt: instantOf(row.starts_at),
    scheduleStatedAt: instantOf(row.schedule_stated_at),
    outcome: row.outcome,
    outcomeStatedAt: instantOf(row.outcome_stated_at),
    version: row.version,
  };
}

function stateColumnsOf(sales: DateSalesSnapshot): StateColumns {
  return {
    channel_id: sales.channelId,
    capacity_total: sales.capacityTotal,
    capacity_tiers: sales.capacityTiers.map(({ id, capacity, openedAt }) => ({
      id,
      capacity,
      openedAt,
    })),
    price_tiers: sales.priceTiers.map(({ tier, amount, active }) => ({
      tier,
      amountMinor: amount.amountMinor,
      currencyCode: amount.currencyCode,
      active,
    })),
    prices_locked_at: dateOf(sales.pricesLockedAt),
    sales_closed_at: dateOf(sales.salesClosedAt),
    starts_at: dateOf(sales.startsAt),
    schedule_stated_at: dateOf(sales.scheduleStatedAt),
    outcome: sales.outcome,
    outcome_stated_at: dateOf(sales.outcomeStatedAt),
    version: sales.version,
  };
}
