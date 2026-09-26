import { createTopics, startStack, type StartedStack } from '@arthome-platform/testing';
import { Kafka, type Admin, type Producer } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runConsumers } from './consume.js';
import { ATTEMPT_HEADER, NOT_BEFORE_HEADER, ORIGIN_HEADER, type Disposition } from './dispatch.js';
import { retryTopic } from './failure.js';

/**
 * The retry backoff, against a real broker.
 *
 * THIS FILE EXISTS BECAUSE `consume.ts` HAD NO TEST AT ALL, and a blocker lived
 *   in it: the delayed message's offset was committed before its backoff elapsed,
 *   so any restart inside the wait dropped a committed business fact. Unit tests
 *   could not have caught it — the defect is in KafkaJS's offset bookkeeping, not
 *   in our branching, and a fake consumer has no offsets to get wrong.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 120_000;
const SERVICE = 'harness';
const SOURCE_TOPIC = 'arthome.harness.source';

let stack: StartedStack;
let kafka: Kafka;
let admin: Admin;
let producer: Producer;

/** What the group has committed for partition 0 of its retry topic, or null. */
async function committedOffset(): Promise<string | null> {
  const offsets = await admin.fetchOffsets({
    groupId: `${SERVICE}-retry`,
    topics: [retryTopic(SERVICE)],
  });
  const partition = offsets[0]?.partitions.find((p) => p.partition === 0);
  // KafkaJS reports "-1" for "this group has committed nothing here".
  return partition === undefined || partition.offset === '-1' ? null : partition.offset;
}

beforeAll(async () => {
  stack = await startStack({ kafka: true, startupTimeoutMs: STARTUP_MS });
  kafka = new Kafka({ clientId: 'consume-itest', brokers: [...stack.kafka.brokers] });
  admin = kafka.admin();
  await admin.connect();
  await createTopics(kafka, [
    { topic: SOURCE_TOPIC, partitions: 1 },
    { topic: retryTopic(SERVICE), partitions: 1 },
  ]);
  producer = kafka.producer();
  await producer.connect();
}, STARTUP_MS);

afterAll(async () => {
  await producer?.disconnect();
  await admin?.disconnect();
  await stack?.stop();
});

describe('the retry backoff', () => {
  it(
    'does NOT commit the offset while a message is waiting out its delay',
    async () => {
      const waitMs = 20_000;
      const notBefore = new Date(Date.now() + waitMs);

      await producer.send({
        topic: retryTopic(SERVICE),
        messages: [
          {
            key: Buffer.from('k'),
            value: Buffer.from('irrelevant — the handler is never reached until it is due'),
            headers: {
              [ORIGIN_HEADER]: Buffer.from(SOURCE_TOPIC),
              [ATTEMPT_HEADER]: Buffer.from('1'),
              [NOT_BEFORE_HEADER]: Buffer.from(notBefore.toISOString()),
            },
          },
        ],
      });

      const seen: Disposition[] = [];
      const stop = await runConsumers({
        kafka,
        producer,
        service: SERVICE,
        sources: [
          {
            topic: SOURCE_TOPIC,
            handler: () => {
              seen.push('applied');
              return Promise.resolve('applied');
            },
          },
        ],
        onDisposition: (_topic, disposition) => void seen.push(disposition),
      });

      try {
        // Give the group time to join and fetch. The message is fetched and held;
        // the handler must not have run.
        await new Promise((resolve) => setTimeout(resolve, 8_000));
        expect(seen).toEqual([]);

        // THE ASSERTION THAT WOULD HAVE CAUGHT THE BLOCKER. With the old
        //   pause/seek/setTimeout, `eachMessage` had already returned, so KafkaJS
        //   had resolved and auto-committed `offset + 1` — and a restart here
        //   dropped the message. Holding inside the handler means nothing is
        //   committed until the work is done.
        expect(await committedOffset()).toBeNull();

        // Now let it come due and be applied.
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        expect(seen).toContain('applied');
        expect(await committedOffset()).not.toBeNull();
      } finally {
        await stop();
      }
    },
    CASE_MS,
  );
});
