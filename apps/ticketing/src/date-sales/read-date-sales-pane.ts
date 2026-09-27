import type { EntityManager } from 'typeorm';

import { dateSalesPaneOf, type DateSalesPane } from './date-sales-pane.js';
import { DateSalesRow } from './date-sales.entity.js';

/**
 * Read off the row rather than the aggregate: the counters a command did not touch may have moved
 *   since its load, and the pane serves them as they stand.
 */
export async function readDateSalesPane(
  manager: EntityManager,
  dateId: string,
): Promise<DateSalesPane | null> {
  const row = await manager.findOneBy(DateSalesRow, { date_id: dateId });
  return row === null ? null : dateSalesPaneOf(row);
}
