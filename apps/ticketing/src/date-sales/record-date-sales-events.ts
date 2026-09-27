import type { EntityManager } from 'typeorm';

import {
  writeDateSalesIntegrationEvents,
  type DateSalesWireContext,
} from './date-sales-integration-events.js';
import type { DateSalesEvent } from './date-sales.events.js';
import { markAvailabilityMoved } from '../availability/mark-availability-moved.js';

/**
 * Every consequence of a date's events inside its command's transaction: the mark the availability
 *   publisher reads, and the outbox rows. A command calls this once, after its save.
 */
export async function recordDateSalesEvents(
  manager: EntityManager,
  events: readonly DateSalesEvent[],
  context: DateSalesWireContext,
): Promise<void> {
  await markAvailabilityMoved(manager, events);
  await writeDateSalesIntegrationEvents(manager, events, context);
}
