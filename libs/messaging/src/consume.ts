import type { Consumer, Kafka, Producer } from 'kafkajs';

import {
  NOT_BEFORE_HEADER,
  dispatch,
  header,
  type Disposition,
  type MessageHandler,
} from './dispatch.js';
import { retryTopic } from './failure.js';

export interface ConsumerSetup {
  readonly kafka: Kafka;
  readonly producer: Producer;
  /** The consuming service's own name. Groups and topics are derived from it. */
  readonly service: string;
  /** The topics this service consumes, and the handler for each. */
  readonly sources: readonly { readonly topic: string; readonly handler: MessageHandler }[];
  readonly onDisposition?: (topic: string, disposition: Disposition) => void;
}

/**
 * Subscribe a service to its topics and to its own retry topic.
 *
 * ⚠ THE RETRY TOPIC GETS ITS OWN CONSUMER AND ITS OWN GROUP. It has to: honouring
 *   a delay means PAUSING the partition, and doing that on the main consumer
 *   would stall live traffic behind a message that is deliberately waiting.
 *
 * ⚠ ONE GROUP PER SERVICE, never one shared across services. A shared group makes
 *   the leader assign only its own topics and the others go unconsumed — silently
 *   (events.md §1.4).
 *
 * Returns a `stop` that leaves the groups cleanly. ⚠ A consumer killed without
 * disconnecting stays a member until its session times out, and the group sits in
 * PreparingRebalance for that whole time — during which its REPLACEMENT consumes
 * nothing. In a rolling deploy that is a stall at every pod, and it looks like a
 * broker problem rather than a missing call.
 */
export async function runConsumers(setup: ConsumerSetup): Promise<() => Promise<void>> {
  const { kafka, producer, service, sources, onDisposition } = setup;
  const byTopic = new Map(sources.map((s) => [s.topic, s.handler]));
  const started: Consumer[] = [];

  const start = async (consumer: Consumer, topic: string, honourDelay: boolean): Promise<void> => {
    await consumer.connect();
    started.push(consumer);
    await consumer.subscribe({ topic, fromBeginning: true });
    await consumer.run({
      eachMessage: async (payload) => {
        if (honourDelay) {
          const notBefore = header(payload, NOT_BEFORE_HEADER);
          const waitMs = notBefore === null ? 0 : Date.parse(notBefore) - Date.now();
          if (waitMs > 0) {
            // ⚠ KAFKA DELAYS NOTHING, so the wait happens here — and returning
            //   without seeking would COMMIT the offset and lose the message.
            //   Pause, seek back to this very offset, resume when due.
            const resume = payload.pause();
            setTimeout(() => {
              consumer.seek({
                topic,
                partition: payload.partition,
                offset: payload.message.offset,
              });
              resume();
            }, waitMs);
            return;
          }
        }

        // On the retry topic the original topic decides the handler, because the
        // message is a copy of something that arrived somewhere else.
        const origin = header(payload, 'arthome-origin-topic') ?? payload.topic;
        const handler = byTopic.get(origin);
        if (handler === undefined) {
          onDisposition?.(payload.topic, 'ignored');
          return;
        }

        const disposition = await dispatch(handler, producer, service, payload);
        onDisposition?.(payload.topic, disposition);
      },
    });
  };

  for (const source of sources) {
    await start(kafka.consumer({ groupId: service }), source.topic, false);
  }
  await start(kafka.consumer({ groupId: `${service}-retry` }), retryTopic(service), true);

  return async () => {
    await Promise.allSettled(started.map((c) => c.disconnect()));
  };
}
