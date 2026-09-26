/**
 * The Kafka helpers, proved against a real broker.
 *
 * NAMED `.itest.ts` AND NOT `.spec.ts`, for the reason given in `index.ts`:
 *   `pnpm run verify` ends in `vitest run`, and a container start inside the
 *   commit gate is how the gate stops being run.
 *
 * Three of the four assertions below cannot be made without a broker. That a
 * topic really has the partitions it was asked for, that a consumer created on
 * the spot really reads a message produced before it existed, and that a header
 * survives a round trip through Kafka's own serialisation are all statements
 * about the broker, not about this code.
 */

import { randomUUID } from 'node:crypto';

import { Kafka, logLevel } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTopics, waitForMessage } from './kafka.js';
import { startKafka, type StartedKafka } from './stack.js';

const STARTUP_BUDGET_MS = 300_000;
const TEST_BUDGET_MS = 60_000;

/** Belongs to no bounded context, so it copies no vocabulary member. */
const TOPIC = 'arthome.harness.probe';

/**
 * Three, as `events.md` §3 fixes for a topic of this shape — and the number the
 * broker would NOT have chosen. Its own default is one, and a topic
 * auto-created with one partition cannot be corrected without re-hashing every
 * key and losing the per-aggregate ordering the key exists to guarantee.
 */
const PARTITIONS = 3;

describe('the Kafka helpers, against a real broker', () => {
  let broker: StartedKafka;
  let kafka: Kafka;

  beforeAll(async () => {
    broker = await startKafka(STARTUP_BUDGET_MS);
    kafka = new Kafka({
      clientId: 'arthome-testing',
      brokers: [...broker.endpoint.brokers],
      // A broker that is being started and stopped produces connection warnings
      // that are not findings. The test's own failures are the output worth
      // reading.
      logLevel: logLevel.NOTHING,
    });
    await createTopics(kafka, [{ topic: TOPIC, partitions: PARTITIONS }]);
  }, STARTUP_BUDGET_MS);

  afterAll(async () => {
    await broker.stop();
  }, TEST_BUDGET_MS);

  it(
    'creates a topic with the partitions it was given, not the broker default',
    async () => {
      const admin = kafka.admin();
      try {
        await admin.connect();
        const metadata = await admin.fetchTopicMetadata({ topics: [TOPIC] });
        expect(metadata.topics[0]?.partitions).toHaveLength(PARTITIONS);
      } finally {
        await admin.disconnect();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    'waits for the message the predicate names, past the ones it does not',
    async () => {
      const wanted = randomUUID();
      const producer = kafka.producer();
      try {
        await producer.connect();
        await producer.send({
          topic: TOPIC,
          messages: [
            { key: randomUUID(), value: 'first' },
            { key: wanted, value: 'second' },
          ],
        });
      } finally {
        await producer.disconnect();
      }

      // The consumer does not exist until here, and the messages are already on
      // the topic. `fromBeginning` is what makes that work, and a fresh group id
      // per call is what makes `fromBeginning` mean anything.
      const found = await waitForMessage(kafka, {
        topic: TOPIC,
        matches: (message) => message.key === wanted,
        timeoutMs: 30_000,
      });

      expect(found.key).toBe(wanted);
      expect(found.value?.toString('utf8')).toBe('second');
    },
    TEST_BUDGET_MS,
  );

  it(
    'reads headers as strings, and drops the literal that Debezium writes for a NULL',
    async () => {
      const messageId = randomUUID();
      const producer = kafka.producer();
      try {
        await producer.connect();
        await producer.send({
          topic: TOPIC,
          messages: [
            {
              key: messageId,
              value: 'headers',
              headers: {
                'message-id': messageId,
                type: 'harness.probe.happened.v1',
                // THIS IS WHAT DEBEZIUM PUTS ON THE WIRE for a NULL column:
                //   the four characters `null`, not an absent header. Kept, it
                //   is how a trace id becomes the word "null" in a database.
                traceparent: 'null',
              },
            },
          ],
        });
      } finally {
        await producer.disconnect();
      }

      const found = await waitForMessage(kafka, {
        topic: TOPIC,
        matches: (message) => message.headers['message-id'] === messageId,
        timeoutMs: 30_000,
      });

      expect(found.headers['message-id']).toBe(messageId);
      expect(found.headers.type).toBe('harness.probe.happened.v1');
      expect(found.headers).not.toHaveProperty('traceparent');
    },
    TEST_BUDGET_MS,
  );

  it(
    'gives up with a count rather than hanging when nothing matches',
    async () => {
      // A waiting helper that hangs is worse than one that fails: the runner's
      // own timeout kills the file, and the report says nothing about which
      // message never came.
      await expect(
        waitForMessage(kafka, {
          topic: TOPIC,
          matches: () => false,
          timeoutMs: 3_000,
        }),
      ).rejects.toThrow(/nothing matched on arthome\.harness\.probe within 3000 ms/);
    },
    TEST_BUDGET_MS,
  );
});
