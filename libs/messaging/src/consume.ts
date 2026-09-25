import type { Consumer, Kafka, Producer } from 'kafkajs';

import {
  NOT_BEFORE_HEADER,
  ORIGIN_HEADER,
  dispatch,
  header,
  type Disposition,
  type MessageHandler,
} from './dispatch.js';
import { retryTopic } from './failure.js';

/**
 * KafkaJS's own defaults, written out because the heartbeat slice below is derived from them
 * and a derived number must not silently follow a default that changes. Tuning them is
 * events.md §2's mitigation for KafkaJS's eager rebalancing.
 */
const SESSION_TIMEOUT_MS = 30_000;
const REBALANCE_TIMEOUT_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 3_000;

/**
 * ⚠ KafkaJS consumes one message at a time by default (`partitionsConsumedConcurrently` is
 *   1), so a 12-partition topic drains serially. Order still holds per partition, which is
 *   the only guarantee the event path rests on.
 */
const DEFAULT_CONCURRENCY = 3;

export interface ConsumerSetup {
  readonly kafka: Kafka;
  readonly producer: Producer;
  /** The consuming service's own name. Groups and topics are derived from it. */
  readonly service: string;
  readonly sources: readonly { readonly topic: string; readonly handler: MessageHandler }[];
  readonly onDisposition?: (topic: string, disposition: Disposition) => void;
  readonly concurrency?: number;
}

/**
 * ⚠ This replaced a `pause()` + `setTimeout` + `seek()` that LOST MESSAGES, and the mechanism
 *   is worth stating because it looked correct. KafkaJS resolves the offset unconditionally
 *   as soon as `eachMessage` returns (`runner.js`: `resolveOffset` at :254, the pause only
 *   breaks the loop at :258), storing `offset + 1` — so returning early committed past a
 *   message whose only copy was that retry record, for up to five minutes on the third tier.
 *   A restart, a SIGTERM deploy, an OOM kill or a reassignment inside that window dropped a
 *   committed business fact silently: `seek` is a no-op once the partition has left the
 *   assignment. Waiting here resolves the offset only after the message has been handled,
 *   holding the retry partition for the duration — which is what a retry topic is for.
 * ⚠ On shutdown it throws rather than returning: returning would commit the offset and lose
 *   the message. `not-before` is absolute, so the replacement computes what remains.
 */
async function waitUntilDue(
  waitMs: number,
  heartbeat: () => Promise<void>,
  isStopping: () => boolean,
): Promise<void> {
  const due = Date.now() + waitMs;
  while (Date.now() < due) {
    if (isStopping()) {
      throw new Error(
        'consumer is shutting down during a retry backoff — leaving the message uncommitted ' +
          'so it is redelivered rather than dropped',
      );
    }
    const slice = Math.min(HEARTBEAT_INTERVAL_MS, due - Date.now());
    if (slice > 0) await new Promise((resolve) => setTimeout(resolve, slice));
    await heartbeat();
  }
}

/**
 * Subscribe a service to its topics and to its own retry topic.
 *
 * ⚠ The retry topic gets its own consumer and its own group: honouring a delay means BLOCKING
 *   the handler for up to five minutes, and doing that on the main consumer would stall live
 *   traffic behind a message that is deliberately waiting.
 * ⚠ One group per service, never one shared across services — a shared group makes the leader
 *   assign only its own topics and the others go unconsumed, silently (events.md §1.4).
 * ⚠ The returned `stop` must be called: a consumer killed without disconnecting stays a member
 *   until its session times out, and the group sits in PreparingRebalance for that whole time
 *   while its replacement consumes nothing. In a rolling deploy that is a stall at every pod,
 *   and it looks like a broker problem rather than a missing call.
 */
export async function runConsumers(setup: ConsumerSetup): Promise<() => Promise<void>> {
  const { kafka, producer, service, sources, onDisposition } = setup;
  const byTopic = new Map(sources.map((s) => [s.topic, s.handler]));
  const started: Consumer[] = [];
  let stopping = false;

  const group = (groupId: string): Consumer =>
    kafka.consumer({
      groupId,
      sessionTimeout: SESSION_TIMEOUT_MS,
      rebalanceTimeout: REBALANCE_TIMEOUT_MS,
      heartbeatInterval: HEARTBEAT_INTERVAL_MS,
    });

  const start = async (
    consumer: Consumer,
    topics: readonly string[],
    honourDelay: boolean,
  ): Promise<void> => {
    await consumer.connect();
    started.push(consumer);
    await consumer.subscribe({ topics: [...topics], fromBeginning: true });
    await consumer.run({
      partitionsConsumedConcurrently: setup.concurrency ?? DEFAULT_CONCURRENCY,
      eachMessage: async (payload) => {
        if (honourDelay) {
          const notBefore = header(payload, NOT_BEFORE_HEADER);
          const waitMs = notBefore === null ? 0 : Date.parse(notBefore) - Date.now();
          if (waitMs > 0)
            await waitUntilDue(
              waitMs,
              () => payload.heartbeat(),
              () => stopping,
            );
        }

        // On the retry topic the origin decides the handler: the message is a copy of
        // something that arrived somewhere else.
        const origin = header(payload, ORIGIN_HEADER) ?? payload.topic;
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

  // ⚠ One consumer for ALL the sources, not one per topic. Several members of one group with
  //   disjoint subscriptions is the trap events.md §1.4 names: KafkaJS assigns with the
  //   LEADER's own subscription (`consumerGroup.js`: `assigner.assign({ members, topics:
  //   topicsSubscribed })`), so later topics get no assignment and go unconsumed, silently.
  //   Both services pass exactly one source today, which is the only reason this never showed.
  await start(
    group(service),
    sources.map((s) => s.topic),
    false,
  );
  await start(group(`${service}-retry`), [retryTopic(service)], true);

  return async () => {
    // Set before disconnecting: a handler waiting out a backoff sees it, throws, and leaves
    // its message uncommitted for the next process to redeliver.
    stopping = true;
    await Promise.allSettled(started.map((c) => c.disconnect()));
  };
}
