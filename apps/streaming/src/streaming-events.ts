import { outboxWriter, type OutboxWriter, type ServiceEvent } from '@arthome-platform/messaging';

/** The aggregate types streaming publishes, each naming its topic `arthome.<type>` (events.md §3). */
type StreamingTopic = 'streaming.run';

/**
 * The topic of every event streaming publishes, named by its aggregate type. A caller names the
 *   type, never the topic. An incident is a facet of its run, so it rides the run's topic and key
 *   (events.md §3.1).
 */
export const STREAMING_EVENT_TOPICS = {
  'streaming.run.technical_check_passed.v1': 'streaming.run',
  'streaming.run.started.v1': 'streaming.run',
  'streaming.run.ended.v1': 'streaming.run',
  'streaming.run.state_changed.v1': 'streaming.run',
  'streaming.incident.raised.v1': 'streaming.run',
  'streaming.incident.resolved.v1': 'streaming.run',
} as const satisfies Record<string, StreamingTopic>;

export type StreamingEventType = keyof typeof STREAMING_EVENT_TOPICS;

export type StreamingEvent = ServiceEvent<StreamingEventType>;

export const writeStreamingEvent: OutboxWriter<StreamingEventType> =
  outboxWriter(STREAMING_EVENT_TOPICS);
