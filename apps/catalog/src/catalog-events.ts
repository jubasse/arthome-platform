import { outboxWriter, type OutboxWriter, type ServiceEvent } from '@arthome-platform/messaging';

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
  'catalog.date.outcome_declared.v1': 'catalog.date',
  'catalog.date.rescheduled.v1': 'catalog.date',
  'catalog.artist.updated.v1': 'catalog.artist',
} as const;

export type CatalogEventType = keyof typeof CATALOG_EVENT_TOPICS;

/** Keyed by the aggregate's id: `show_id`, `date_id` or `artist_id`. */
export type CatalogEvent = ServiceEvent<CatalogEventType>;

export const writeCatalogEvent: OutboxWriter<CatalogEventType> = outboxWriter(CATALOG_EVENT_TOPICS);
