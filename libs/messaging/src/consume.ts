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
 * KafkaJS's own defaults, written out because the wait below is derived from them
 * and a derived number must not silently follow a default that changes.
 *
 * ⚠ `events.md` §2 names tuning these as the mitigation for KafkaJS's eager
 *   rebalancing, and nothing was tuning them.
 */
const SESSION_TIMEOUT_MS = 30_000;
const REBALANCE_TIMEOUT_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 3_000;

/**
 * ⚠ KAFKAJS CONSUMES ONE MESSAGE AT A TIME BY DEFAULT — `partitionsConsumedConcurrently`
 *   is 1 — so a 12-partition topic is drained serially. `events.md` §2 calls that
 *   out as "not a detail". Order still holds per partition, which is the only
 *   guarantee the event path rests on.
 */
const DEFAULT_CONCURRENCY = 3;

export interface ConsumerSetup {
  readonly kafka: Kafka;
  readonly producer: Producer;
  /** The consuming service's own name. Groups and topics are derived from it. */
  readonly service: string;
  /** The topics this service consumes, and the handler for each. */
  readonly sources: readonly { readonly topic: string; readonly handler: MessageHandler }[];
  readonly onDisposition?: (topic: string, disposition: Disposition) => void;
  /** Partitions drained in parallel per consumer. Defaults to 3. */
  readonly concurrency?: number;
}

/**
 * Hold the message until its `not-before` passes, heartbeating so the broker does
 * not evict us, and give up if the service is shutting down.
 *
 * ⚠ THIS REPLACED A `pause()` + `setTimeout` + `seek()` THAT LOST MESSAGES, and
 *   the mechanism is worth stating because it looked correct. KafkaJS resolves
 *   the offset UNCONDITIONALLY as soon as `eachMessage` RETURNS
 *   (`runner.js`: `resolveOffset` at :254, the pause only breaks the loop at
 *   :258, `autoCommitOffsets` at :457), and `resolveOffset` stores `offset + 1`.
 *   So returning early committed past a message whose ONLY copy was that retry
 *   record — for up to five minutes on the third tier. A restart, a SIGTERM
 *   deploy, an OOM kill or a partition reassignment inside that window dropped a
 *   committed business fact silently and unrecoverably: `seek` is a no-op once
 *   the partition has left the assignment, and the replacement consumer starts
 *   at `offset + 1`. The window is exactly the one an incident creates.
 *
 *   Waiting HERE means the offset is resolved only after the message has been
 *   handled. It holds the retry partition for the duration, which is what a retry
 *   topic is for — and the main topic keeps moving because it is a different
 *   consumer in a different group.
 *
 * ⚠ ON SHUTDOWN IT THROWS RATHER THAN RETURNING. Returning would commit the
 *   offset and lose the message, which is the very fault this function exists to
 *   remove; throwing leaves it uncommitted, so it is redelivered. `not-before` is
 *   an absolute instant, so the replacement computes what remains rather than
 *   restarting the wait.
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
 * ⚠ THE RETRY TOPIC GETS ITS OWN CONSUMER AND ITS OWN GROUP. It has to: honouring
 *   a delay means BLOCKING the handler for up to five minutes (`waitUntilDue`),
 *   and doing that on the main consumer would stall live traffic behind a message
 *   that is deliberately waiting. A separate group is what confines the stall to
 *   the retry topic.
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

        // On the retry topic the original topic decides the handler, because the
        // message is a copy of something that arrived somewhere else.
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

  // ⚠ ONE CONSUMER FOR ALL THE SOURCES, NOT ONE PER TOPIC. Several members of one
  //   group with DISJOINT subscriptions is the trap events.md §1.4 names: KafkaJS
  //   assigns with the LEADER's own subscription (`consumerGroup.js`:
  //   `assigner.assign({ members, topics: topicsSubscribed })`), so the second and
  //   later topics get no assignment and go unconsumed — silently. Both services
  //   pass exactly one source today, which is the only reason this never showed.
  await start(
    group(service),
    sources.map((s) => s.topic),
    false,
  );
  await start(group(`${service}-retry`), [retryTopic(service)], true);

  return async () => {
    // Set before disconnecting: a handler waiting out a backoff sees it, throws,
    // and leaves its message uncommitted for the next process to redeliver.
    stopping = true;
    await Promise.allSettled(started.map((c) => c.disconnect()));
  };
}
