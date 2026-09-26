import { writeOutboxEvent } from '@arthome-platform/messaging';
import type { EntityManager } from 'typeorm';

/**
 * The topic of every event catalog publishes, named by its aggregate type. The publication's
 * events travel on the date's topic, keyed by `date_id`: on a topic of their own, `engaged` would
 * lose its order with `date.scheduled` (events.md §3.1). A caller names the type, never the topic.
 */
export const CATALOG_EVENT_TOPICS = {
  'catalog.show.published.v1': 'catalog.show',
  'catalog.show.updated.v1': 'catalog.show',
  'catalog.date.drafted.v1': 'catalog.date',
  'catalog.date.scheduled.v1': 'catalog.date',
  'catalog.publication.state_changed.v1': 'catalog.date',
  'catalog.publication.engaged.v1': 'catalog.date',
} as const;

export type CatalogEventType = keyof typeof CATALOG_EVENT_TOPICS;

export interface CatalogEvent {
  readonly type: CatalogEventType;
  /** The partition key: `show_id` on the show's topic, `date_id` on the date's. */
  readonly key: string;
  readonly payload: Uint8Array;
  readonly traceparent: string | null;
}

export function writeCatalogEvent(
  manager: EntityManager,
  event: CatalogEvent,
  occurredAt: Date,
): Promise<string> {
  return writeOutboxEvent(
    manager,
    {
      aggregateType: CATALOG_EVENT_TOPICS[event.type],
      aggregateId: event.key,
      type: event.type,
      payload: event.payload,
      traceparent: event.traceparent,
      // No verified actor while tokens are not verified (critical-rules #4): an unverified name
      // in a journal that decides money is worse than none.
      actorId: null,
    },
    occurredAt,
  );
}
