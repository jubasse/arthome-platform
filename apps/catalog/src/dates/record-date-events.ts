import type { EntityManager } from 'typeorm';

import { writeDateIntegrationEvents, type DateWireContext } from './date-integration-events.js';
import { projectDateEvents, type DateCopies } from '../public/date-detail-projection.js';
import { retireSlugsMovedFrom } from '../public/slug-aliases.js';
import type { DateKeyedEvent } from '../replays/replay.events.js';

/**
 * Every consequence of a date's events inside its command's transaction: the slugs a move
 *   replaced, its public row, its outbox rows. Each ignores the events it does not concern, so a
 *   date command calls this once, after its saves, whatever it decided, with the date's events
 *   first and its `Replay`'s after them.
 */
export async function recordDateEvents(
  manager: EntityManager,
  events: readonly DateKeyedEvent[],
  context: DateWireContext & DateCopies,
): Promise<void> {
  await retireSlugsMovedFrom(manager, events);
  await projectDateEvents(manager, events, context);
  await writeDateIntegrationEvents(manager, events, context);
}
