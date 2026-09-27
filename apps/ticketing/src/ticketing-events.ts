import { writeOutboxEvent } from '@arthome-platform/messaging';
import type { EntityManager } from 'typeorm';

/**
 * The topic of every event ticketing publishes, named by its aggregate type (events.md §3). A
 *   caller names the type, never the topic.
 */
export const TICKETING_EVENT_TOPICS = {
  'ticketing.date_sales.capacity_set.v1': 'ticketing.date_sales',
  'ticketing.date_sales.pricing_changed.v1': 'ticketing.date_sales',
  'ticketing.date_sales.availability_changed.v1': 'ticketing.date_sales',
} as const;

export type TicketingEventType = keyof typeof TICKETING_EVENT_TOPICS;

export interface TicketingEvent {
  readonly type: TicketingEventType;
  /** The partition key: `date_id` on `arthome.ticketing.date_sales`. */
  readonly key: string;
  readonly payload: Uint8Array;
  readonly traceparent: string | null;
}

export function writeTicketingEvent(
  manager: EntityManager,
  event: TicketingEvent,
  occurredAt: Date,
): Promise<string> {
  return writeOutboxEvent(
    manager,
    {
      aggregateType: TICKETING_EVENT_TOPICS[event.type],
      aggregateId: event.key,
      type: event.type,
      payload: event.payload,
      traceparent: event.traceparent,
      // No verified actor while tokens are not verified (critical-rules #4).
      actorId: null,
    },
    occurredAt,
  );
}
