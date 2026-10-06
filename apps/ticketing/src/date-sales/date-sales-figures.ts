import {
  availabilityOf,
  fillRateBps,
  lowestActivePrice,
  money,
  seatsAvailable,
  type Gauge,
  type Money,
  type TierPrice,
} from '@arthome/core';

import type { DateSalesRow } from './date-sales.entity.js';

type GaugeColumns = Pick<
  DateSalesRow,
  'capacity_total' | 'seats_available' | 'seats_sold' | 'waitlist_count'
>;

/** What the pane, the public read and `availability_changed` state, each through core. */
export interface AvailabilityFigures {
  readonly seatsAvailable: number;
  readonly waitlistCount: number;
  readonly fillRateBps: number;
  readonly soldOut: boolean;
  /** The headline price, null while no tier is active. */
  readonly lowestPrice: Money | null;
}

/** `seats_available` is what is left once sold and held are taken: the held ones are the rest. */
export function gaugeOf(row: GaugeColumns): Gauge {
  return {
    capacityTotal: row.capacity_total,
    seatsSold: row.seats_sold,
    seatsHeld: row.capacity_total - row.seats_sold - row.seats_available,
    waitlistCount: row.waitlist_count,
    // No priority pool opens before the waiting list's (T5, PT3).
    priorityPoolSeats: 0,
  };
}

export function tierPricesOf(row: Pick<DateSalesRow, 'price_tiers'>): TierPrice[] {
  return row.price_tiers.map(({ tier, amountMinor, currencyCode, active }) => ({
    tier,
    amount: money(amountMinor, currencyCode),
    active,
  }));
}

export function availabilityFiguresOf(
  row: GaugeColumns & Pick<DateSalesRow, 'price_tiers'>,
): AvailabilityFigures {
  const gauge = gaugeOf(row);
  return {
    seatsAvailable: seatsAvailable(gauge),
    waitlistCount: gauge.waitlistCount,
    fillRateBps: fillRateBps(gauge),
    soldOut: availabilityOf(gauge).kind !== 'seats_available',
    lowestPrice: lowestActivePrice(tierPricesOf(row)),
  };
}
