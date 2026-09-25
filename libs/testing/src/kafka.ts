/**
 * Kafka has no "give me the message that was just produced": every step of the
 * group, assignment, offset and poll loop is a way for a test to hang instead of
 * failing. One call here either returns the message or says how long it waited.
 */

import { randomUUID } from 'node:crypto';

import { header } from '@arthome-platform/messaging';
import type { EachMessagePayload, Kafka } from 'kafkajs';

export interface TopicSpec {
  readonly topic: string;
  /** `events.md` §3 fixes this per topic; it is never left to the broker. */
  readonly partitions: number;
}

export interface ObservedMessage {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly key: string | null;
  readonly value: Buffer | null;
  /** Debezium's literal `"null"` is already absent here. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface WaitForMessageOptions {
  readonly topic: string;
  readonly matches?: (message: ObservedMessage) => boolean;
  readonly timeoutMs?: number;
  /** True by default: the awaited message is usually produced before the consumer exists. */
  readonly fromBeginning?: boolean;
}

const DEFAULT_WAIT_MS = 30_000;

/**
 * ⚠ Debezium renders a NULL column as the four characters `null`, not as a
 *   missing header. `messaging/dispatch.ts` owns that rule; a second copy here
 *   would diverge invisibly — both versions return a string, one is a trace id.
 */
export function headersOf(payload: EachMessagePayload): Readonly<Record<string, string>> {
  const named: Record<string, string> = {};
  for (const name of Object.keys(payload.message.headers ?? {})) {
    const value = header(payload, name);
    if (value !== null) named[name] = value;
  }
  return named;
}

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
 * ⚠ A topic nobody created is auto-created by the first producer with the
 *   broker's default of one partition, where `events.md` §3 fixes 3 or 12 — and
 *   raising them later re-hashes every key. A consumer, meanwhile, cannot
 *   subscribe to a missing topic: KafkaJS says "This server does not host this
 *   topic-partition", which reads like a broker fault.
 *
 * `waitForLeaders` makes this mean "ready" rather than "requested".
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
        // One broker in the harness: the one setting deliberately not production's.
        replicationFactor: 1,
      })),
    });
  } finally {
    await admin.disconnect();
  }
}

/**
 * ⚠ A fresh group every time, because KafkaJS honours `fromBeginning` only when
 *   the group has no committed offset: a reused id resumes after the previous
 *   test's message and waits for ever.
 *
 * ⚠ The consumer is disconnected whatever happens. Dropped without leaving, it
 *   stays a member until its session times out, and the next test's consumer is
 *   assigned nothing for that whole time.
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
