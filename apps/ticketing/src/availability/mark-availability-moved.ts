import type { EntityManager } from 'typeorm';

import { assertNever } from '../assert-never.js';
import type { DateSalesEvent } from '../date-sales/date-sales.events.js';

/** Whether the event moves a figure `availability_changed` carries: a seat count or a price. */
function movesAvailability(event: DateSalesEvent): boolean {
  switch (event.kind) {
    case 'DatePricesSet':
    case 'DatePricesLocked':
    case 'CapacityTierOpened':
      return true;
    case 'DateSalesOpened':
    case 'DateScheduleRecorded':
    case 'DateOutcomeRecorded':
      return false;
    default:
      return assertNever(event);
  }
}

/**
 * Marks the date for the publisher, in the transaction that moved it (adr-ticketing.md §5). The
 *   first move since the last publication sets the instant; later ones leave it.
 */
export async function markAvailabilityMoved(
  manager: EntityManager,
  events: readonly DateSalesEvent[],
): Promise<void> {
  const first = events.find(movesAvailability);
  if (first === undefined) return;
  await manager.query(
    `UPDATE date_sales
        SET availability_dirty_since = COALESCE(availability_dirty_since, $2)
      WHERE date_id = $1`,
    [first.dateId, new Date(first.occurredAt)],
  );
}
