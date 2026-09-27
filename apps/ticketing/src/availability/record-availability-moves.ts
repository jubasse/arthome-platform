import type { EntityManager } from 'typeorm';

import { DateAvailabilityPublicationRow } from './date-availability-publication.entity.js';
import { assertNever } from '../assert-never.js';
import type { DateSalesEvent } from '../date-sales/date-sales.events.js';

/**
 * Whether the event moves what `availability_changed` carries: a seat count, a price, or the sale
 *   itself closing, which offers no seat from then on.
 */
function movesAvailability(event: DateSalesEvent): boolean {
  switch (event.kind) {
    case 'DatePricesSet':
    case 'DatePricesLocked':
    case 'CapacityTierOpened':
      return true;
    case 'DateOutcomeRecorded':
      return event.salesClosed;
    case 'DateSalesOpened':
    case 'DateScheduleRecorded':
    case 'TechnicalProvisionSet':
      return false;
    default:
      return assertNever(event);
  }
}

/**
 * What the publisher reads, in the transaction that moved the date (adr-ticketing.md §5): an
 *   opening gives it the date's publication row, a move one more on `availability_moves`, a closing
 *   the flag that keeps the date in the publisher's pass until its last publication. The command
 *   already holds the date's row; T3's decrement counts itself in its own statement.
 */
export async function recordAvailabilityMoves(
  manager: EntityManager,
  events: readonly DateSalesEvent[],
): Promise<void> {
  const opened = events.find(({ kind }) => kind === 'DateSalesOpened');
  if (opened !== undefined) {
    await manager.insert(DateAvailabilityPublicationRow, { date_id: opened.dateId });
  }
  const moved = events.find(movesAvailability);
  if (moved !== undefined) {
    await manager.query(
      'UPDATE date_sales SET availability_moves = availability_moves + 1 WHERE date_id = $1',
      [moved.dateId],
    );
  }
  const closed = events.find((event) => event.kind === 'DateOutcomeRecorded' && event.salesClosed);
  if (closed !== undefined) {
    await manager.update(
      DateAvailabilityPublicationRow,
      { date_id: closed.dateId },
      { closing_due: true },
    );
  }
}
