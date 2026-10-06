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
  'ticketing.seat.cancelled.v1': 'ticketing.date_sales',
  'ticketing.order.paid.v1': 'ticketing.order',
  'ticketing.order.refunded.v1': 'ticketing.order',
  'ticketing.credit.issued.v1': 'ticketing.account',
} as const;

export type TicketingEventType = keyof typeof TICKETING_EVENT_TOPICS;

/**
 * Keyed by `date_id` on `.date_sales`, a seat's too (events.md §3.1); by `order_id` on `.order`; by
 *   `account_id` on `.account`.
 */
export type TicketingEvent = ServiceEvent<TicketingEventType>;

export const writeTicketingEvent: OutboxWriter<TicketingEventType> =
  outboxWriter(TICKETING_EVENT_TOPICS);
