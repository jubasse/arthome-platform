import type { EntityManager } from 'typeorm';

import { dateSalesPaneOf, type DateSalesPane } from './date-sales-pane.js';
import { DateSalesRow } from './date-sales.entity.js';

/**
 * Read off the row rather than the aggregate: the counters are written as deltas, so the row, not
 *   the snapshot, holds them as they stand once T3's decrement moves them without a load.
 */
export async function readDateSalesPane(
  manager: EntityManager,
  dateId: string,
): Promise<DateSalesPane | null> {
  const row = await manager.findOneBy(DateSalesRow, { date_id: dateId });
  return row === null ? null : dateSalesPaneOf(row);
}
