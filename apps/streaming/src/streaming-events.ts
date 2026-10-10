import { outboxWriter, type OutboxWriter, type ServiceEvent } from '@arthome-platform/messaging';

/** The aggregate types streaming publishes, each naming its topic `arthome.<type>` (events.md §3). */
type StreamingTopic = 'streaming.run';

/**
 * The topic of every event streaming publishes, named by its aggregate type. A caller names the
 *   type, never the topic. Empty until arthome-core's proto defines the service's events.
 */
export const STREAMING_EVENT_TOPICS = {} as const satisfies Record<string, StreamingTopic>;

export type StreamingEventType = keyof typeof STREAMING_EVENT_TOPICS;

export type StreamingEvent = ServiceEvent<StreamingEventType>;

export const writeStreamingEvent: OutboxWriter<StreamingEventType> =
  outboxWriter(STREAMING_EVENT_TOPICS);
