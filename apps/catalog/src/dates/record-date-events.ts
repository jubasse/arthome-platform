import type { EntityManager } from 'typeorm';

import { writeDateIntegrationEvents, type DateWireContext } from './date-integration-events.js';
import type { PerformanceDateEvent } from './performance-date.events.js';
import { projectDateEvents, type DateCopies } from '../public/date-detail-projection.js';
import { retireSlugsMovedFrom } from '../public/slug-aliases.js';

/**
 * Every consequence of a date's events inside its command's transaction: the slugs a move
 *   replaced, its public row, its outbox rows. Each ignores the events it does not concern, so a
 *   date command calls this once, after its save, whatever it decided.
 */
export async function recordDateEvents(
  manager: EntityManager,
  events: readonly PerformanceDateEvent[],
  context: DateWireContext & DateCopies,
): Promise<void> {
  await retireSlugsMovedFrom(manager, events);
  await projectDateEvents(manager, events, context);
  await writeDateIntegrationEvents(manager, events, context);
}
