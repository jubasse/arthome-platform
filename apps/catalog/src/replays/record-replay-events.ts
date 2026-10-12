import type { EntityManager } from 'typeorm';

import { writeReplayIntegrationEvents } from './replay-integration-events.js';
import type { ReplayEvent } from './replay.events.js';
import { projectReplayEvents } from '../public/date-detail-projection.js';

/** `recordDateEvents` for a command that moved the `Replay` alone: its public row, its outbox rows. */
export async function recordReplayEvents(
  manager: EntityManager,
  events: readonly ReplayEvent[],
  traceparent: string | null,
): Promise<void> {
  await projectReplayEvents(manager, events);
  await writeReplayIntegrationEvents(manager, events, traceparent);
}
