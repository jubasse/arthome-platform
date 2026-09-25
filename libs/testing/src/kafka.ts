/**
 * The waiting an event test cannot be written without.
 *
 * Kafka has no "give me the message that was just produced": there is a group,
 * an assignment, an offset and a poll loop, and every one of them is a way for a
 * test to hang instead of failing. What is here turns that into one call that
 * either returns the message or says, with a number, how long it waited and how
 * many messages it did see.
 */

import { randomUUID } from 'node:crypto';

import { header } from '@arthome-platform/messaging';
import type { EachMessagePayload, Kafka } from 'kafkajs';

/** A topic and the partition count it must be created with. */
export interface TopicSpec {
  readonly topic: string;
  /** `events.md` §3 fixes this per topic. It is never left to the broker. */
  readonly partitions: number;
}

/** One message, decoded far enough to assert on without reaching into KafkaJS. */
export interface ObservedMessage {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  /** The partition key as a string. This is what keeps one aggregate in order. */
  readonly key: string | null;
  readonly value: Buffer | null;
  /** Headers as strings. Debezium's literal `"null"` is already absent here. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface WaitForMessageOptions {
  readonly topic: string;
  /** Which message the test is waiting for. Omitted, the first one will do. */
  readonly matches?: (message: ObservedMessage) => boolean;
  readonly timeoutMs?: number;
  /**
   * Whether to read the topic from its start. True by default, and it is what a
   * test almost always means: the message it is waiting for was very often
   * produced before the consumer existed.
   */
  readonly fromBeginning?: boolean;
}

/**
 * Long enough for a consumer to join a group and be assigned a partition, short
 * enough that a test which will never succeed says so while someone is watching.
 */
const DEFAULT_WAIT_MS = 30_000;

/**
 * A message's headers, as strings, with absent ones absent.
 *
 * ⚠ THE `"null"` RULE IS NOT REIMPLEMENTED HERE, AND MUST NOT BE. Debezium
 *   renders a NULL column as the four characters `null` rather than as a missing
 *   header, so a row with no trace context arrives carrying a `traceparent`
 *   whose value is the word "null" — and storing that is how a trace id becomes
 *   a string nobody can follow. `@arthome-platform/messaging` already owns that
 *   decision, in `dispatch.ts`. A second copy of it here would be a parallel
 *   implementation of the one rule in this system whose divergence is invisible:
 *   both versions return a string, and only one of them is a trace id.
 */
export function headersOf(payload: EachMessagePayload): Readonly<Record<string, string>> {
  const named: Record<string, string> = {};
  for (const name of Object.keys(payload.message.headers ?? {})) {
    const value = header(payload, name);
    if (value !== null) named[name] = value;
  }
  return named;
}

/** What `eachMessage` hands over, reduced to what an assertion needs. */
function observe(payload: EachMessagePayload): ObservedMessage {
  return {
    topic: payload.topic,
    partition: payload.partition,
    offset: payload.message.offset,
    key: payload.message.key === null ? null : payload.message.key.toString('utf8'),
    value: payload.message.value,
    headers: headersOf(payload),
  };
}

/**
 * Create topics with the partition counts they are supposed to have.
 *
 * ⚠ A TOPIC NOBODY CREATED IS NOT A TOPIC NOBODY HAS. The first producer
 *   auto-creates it with the BROKER's default partition count — one — while
 *   `events.md` §3 fixes 3 or 12. Partitions cannot be reduced afterwards, and
 *   raising them re-hashes every key, which breaks the per-aggregate ordering
 *   the key exists to guarantee. So a test that lets a topic be auto-created is
 *   not testing the topic the service will run against.
 *
 * ⚠ AND A CONSUMER CANNOT SUBSCRIBE TO A TOPIC THAT DOES NOT EXIST. KafkaJS
 *   fails with "This server does not host this topic-partition", which reads
 *   like a broker fault and is a missing `createTopics`.
 *
 * `waitForLeaders` is what makes this call mean "ready", not "requested": topic
 * creation is asynchronous, and a produce issued in between is refused for a
 * topic that was just created successfully.
 */
export async function createTopics(kafka: Kafka, topics: readonly TopicSpec[]): Promise<void> {
  const admin = kafka.admin();
  try {
    await admin.connect();
    await admin.createTopics({
      waitForLeaders: true,
      topics: topics.map((spec) => ({
        topic: spec.topic,
        numPartitions: spec.partitions,
        // One broker in the harness, so nothing can be replicated anywhere. This
        // is the one setting that is deliberately NOT production's.
        replicationFactor: 1,
      })),
    });
  } finally {
    await admin.disconnect();
  }
}

/**
 * Consume a topic until a message matches, or until the timeout says it will not.
 *
 * ⚠ A FRESH GROUP EVERY TIME, AND THAT IS WHAT MAKES `fromBeginning` MEAN
 *   ANYTHING. KafkaJS honours `fromBeginning` only when the group has no
 *   committed offset; reusing a group id across tests makes the second call
 *   resume after the first one's message and wait for ever on a topic that
 *   already holds what it is waiting for.
 *
 * ⚠ THE CONSUMER IS DISCONNECTED WHATEVER HAPPENS. A consumer that is dropped
 *   without leaving stays a group member until its session times out, and the
 *   group sits in PreparingRebalance for that whole time — during which the NEXT
 *   test's consumer is assigned nothing and times out too. One forgotten
 *   `disconnect` turns into a suite where every test after the first is slow.
 */
export async function waitForMessage(
  kafka: Kafka,
  options: WaitForMessageOptions,
): Promise<ObservedMessage> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS;
  const matches = options.matches ?? ((): boolean => true);
  const consumer = kafka.consumer({ groupId: `arthome-testing-${randomUUID()}` });
  const seen: ObservedMessage[] = [];

  try {
    await consumer.connect();
    await consumer.subscribe({
      topic: options.topic,
      fromBeginning: options.fromBeginning ?? true,
    });

    return await new Promise<ObservedMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `nothing matched on ${options.topic} within ${timeoutMs} ms. ` +
              `${seen.length} message(s) were read: ` +
              `${seen.map((message) => message.key ?? '(no key)').join(', ') || '(none)'}. ` +
              'No message at all usually means the topic was never created, or the ' +
              'producer never flushed.',
          ),
        );
      }, timeoutMs);

      consumer
        .run({
          eachMessage: (payload: EachMessagePayload) => {
            const message = observe(payload);
            seen.push(message);
            if (matches(message)) {
              clearTimeout(timer);
              resolve(message);
            }
            return Promise.resolve();
          },
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  } finally {
    await consumer.disconnect();
  }
}
