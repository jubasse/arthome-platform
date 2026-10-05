import type { z } from 'zod';

import type { DateSalesPaneSchema } from '@arthome/contracts/studio-money';

import { availabilityFiguresOf } from './date-sales-figures.js';
import type { DateSalesRow } from './date-sales.entity.js';
import { technicalProvisionOf } from './technical-provision.js';

export type DateSalesPane = z.output<typeof DateSalesPaneSchema>;

/**
 * The studio's `tickets` pane, as far as `DateSales` holds it. Absent rather than empty or zero:
 *   the service fee and the replay price (no schedule is set anywhere yet), the complimentaries, the
 *   penalty exposure (no rule in core), and `grossRevenue`, which needs `canRevenue` and a sale.
 */
export function dateSalesPaneOf(row: DateSalesRow): DateSalesPane {
  const figures = availabilityFiguresOf(row);
  return {
    dateId: row.date_id,
    capacityTotal: row.capacity_total,
    capacityTiers: row.capacity_tiers.map(({ id, capacity, openedAt }) => ({
      id,
      capacity,
      openedAt,
    })),
    seatsAvailable: figures.seatsAvailable,
    seatsSold: row.seats_sold,
    waitlistCount: figures.waitlistCount,
    fillRateBps: figures.fillRateBps,
    priceTiers: row.price_tiers.map(({ tier, amountMinor, currencyCode, active }) => ({
      tier,
      amount: { amountMinor, currencyCode },
      active,
    })),
    promotions: [],
    pricesLocked: row.prices_locked_at !== null,
    technicalProvision: {
      ...technicalProvisionOf(
        row.capacity_total,
        row.provisioned_capacity,
        row.starts_at?.toISOString() ?? null,
      ),
    },
    version: row.version,
  };
}
