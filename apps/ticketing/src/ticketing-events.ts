import { outboxWriter, type OutboxWriter, type ServiceEvent } from '@arthome-platform/messaging';

/**
 * The topic of every event ticketing publishes, named by its aggregate type (events.md §3). A
 *   caller names the type, never the topic.
 */
export const TICKETING_EVENT_TOPICS = {
  'ticketing.date_sales.capacity_set.v1': 'ticketing.date_sales',
  'ticketing.date_sales.pricing_changed.v1': 'ticketing.date_sales',
  'ticketing.date_sales.availability_changed.v1': 'ticketing.date_sales',
  'ticketing.seat.activated.v1': 'ticketing.date_sales',
  'ticketing.order.paid.v1': 'ticketing.order',
  'ticketing.order.refunded.v1': 'ticketing.order',
} as const;

export type TicketingEventType = keyof typeof TICKETING_EVENT_TOPICS;

/**
 * Keyed by `date_id` on `arthome.ticketing.date_sales`, a seat's events with them (events.md §3.1);
 *   by `order_id` on `arthome.ticketing.order` (D-078).
 */
export type TicketingEvent = ServiceEvent<TicketingEventType>;

export const writeTicketingEvent: OutboxWriter<TicketingEventType> =
  outboxWriter(TICKETING_EVENT_TOPICS);
