import { AggregateTracker, saveVersioned, type Track } from '@arthome-platform/transactions';
import type { EntityManager } from 'typeorm';

import { money, type Instant, type TierPrice } from '@arthome/core';

import { DateSales, type DateSalesSnapshot } from './date-sales.aggregate.js';
import { DateSalesRow, type PriceTierColumn } from './date-sales.entity.js';
import { DateSalesRepository } from './date-sales.repository.js';

type Counter = 'seats_available' | 'seats_sold' | 'waitlist_count';

type StateColumns = Omit<
  DateSalesRow,
  'date_id' | Counter | 'on_sale' | 'availability_moves' | 'created_at' | 'updated_at'
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
    return this.restored(
      await this.manager.findOne(DateSalesRow, {
        where: { date_id: dateId },
        lock: { mode: 'pessimistic_write' },
      }),
    );
  }

  public async findUnlocked(dateId: string): Promise<DateSales | null> {
    return this.restored(await this.manager.findOneBy(DateSalesRow, { date_id: dateId }));
  }

  /**
   * The decrement moves the counter the aggregate's `holdSeats` moved, and the stored snapshot by the
   *   same amount: a save later in the transaction measures no delta, where it would take the seats
   *   a second time. Registered without a version, which the statement leaves as it was.
   */
  public async takeSeats(sales: DateSales, quantity: number, now: Instant): Promise<boolean> {
    const { dateId } = sales.snapshot;
    const taken = await this.affected(
      `UPDATE date_sales
          SET seats_available = seats_available - $2,
              availability_moves = availability_moves + 1
        WHERE date_id = $1 AND on_sale AND seats_available >= $2
          AND ${beforeSalesEnd('$3')}`,
      [dateId, quantity, new Date(now)],
    );
    if (!taken) return false;
    const stored = this.storedSnapshots.get(sales) ?? sales.snapshot;
    this.storedSnapshots.set(sales, {
      ...stored,
      seatsAvailable: stored.seatsAvailable - quantity,
    });
    this.tracker.writtenUnversioned(sales);
    return true;
  }

  public async sellHeldSeats(dateId: string, quantity: number): Promise<void> {
    await this.affected(
      `UPDATE date_sales
          SET seats_sold = seats_sold + $2, availability_moves = availability_moves + 1
        WHERE date_id = $1`,
      [dateId, quantity],
    );
  }

  public async returnHeldSeats(dateId: string, quantity: number): Promise<void> {
    await this.affected(
      `UPDATE date_sales
          SET seats_available = seats_available + $2, availability_moves = availability_moves + 1
        WHERE date_id = $1`,
      [dateId, quantity],
    );
  }

  public takeAndSellSeats(dateId: string, quantity: number, now: Instant): Promise<boolean> {
    return this.affected(
      `UPDATE date_sales
          SET seats_available = seats_available - $2,
              seats_sold = seats_sold + $2,
              availability_moves = availability_moves + 1
        WHERE date_id = $1 AND on_sale AND seats_available >= $2
          AND ${beforeSalesEnd('$3')}`,
      [dateId, quantity, new Date(now)],
    );
  }

  /**
   * The counters move by what the aggregate added since the load, `seats_available + n`. The load's
   *   lock already orders this save after any hold; the delta is what keeps T3's decrement, which
   *   moves the counters with no load and no version, from being undone should a write ever skip it.
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

  private restored(row: DateSalesRow | null): DateSales | null {
    if (row === null) return null;
    const sales = DateSales.restore(dateSalesSnapshotOf(row));
    this.storedSnapshots.set(sales, sales.snapshot);
    return this.tracker.loaded(sales, row.version);
  }

  private async affected(sql: string, parameters: unknown[]): Promise<boolean> {
    return affectedOne(await this.manager.query(sql, parameters));
  }
}

/**
 * D-089's cutoff in the hold's own WHERE, at the command's instant, the statement's parameter
 *   `now`: the sweeper closes a sale up to a second after its end, and a second at an opening's rate
 *   is seats sold past it. One predicate on a row already found by its key costs nothing.
 */
function beforeSalesEnd(now: `$${number}`): string {
  return `(sales_end_at IS NULL OR sales_end_at > ${now})`;
}

function affectedOne(result: unknown): boolean {
  const [, affected] = result as [unknown, number];
  return affected === 1;
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
    provisionedCapacity: row.provisioned_capacity,
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
    salesEndAt: instantOf(row.sales_end_at),
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
    provisioned_capacity: sales.provisionedCapacity,
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
    sales_end_at: dateOf(sales.salesEndAt),
    starts_at: dateOf(sales.startsAt),
    schedule_stated_at: dateOf(sales.scheduleStatedAt),
    outcome: sales.outcome,
    outcome_stated_at: dateOf(sales.outcomeStatedAt),
    version: sales.version,
  };
}
