import 'reflect-metadata';

import { deadLetterTopic, retryTopic } from '@arthome-platform/messaging';
import { Kafka, type Consumer, type EachMessagePayload } from 'kafkajs';

import { Service } from '@arthome/core';

import { NOT_BEFORE_HEADER, dispatch } from './consumer/dispatch.js';
import { dataSource } from './data-source.js';

const SOURCE_TOPIC = 'arthome.identity.account';

function header(payload: EachMessagePayload, name: string): string | null {
  const raw = payload.message.headers?.[name];
  if (raw === undefined || raw === null) return null;
  return Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
}

async function main(): Promise<void> {
  await dataSource.initialize();

  const kafka = new Kafka({
    // ⚠ NAMED FROM THE DOMAIN, not from a literal. `check-enums` caught both of
    //   these as copies of SERVICES, and it was right: a service's own name is a
    //   domain fact, and a typo in a groupId does not fail — it silently forms a
    //   second consumer group that reads everything again from the beginning.
    clientId: Service.NOTIFICATIONS,
    brokers: [process.env.KAFKA_BROKERS ?? 'localhost:29092'],
  });

  const producer = kafka.producer();
  await producer.connect();

  // ⚠ ONE GROUP PER SERVICE, never one shared across services. A shared group
  //   makes the leader assign only its own topics and the others go unconsumed
  //   — silently (events.md §1.4).
  const main = kafka.consumer({ groupId: Service.NOTIFICATIONS });
  const retries = kafka.consumer({ groupId: `${Service.NOTIFICATIONS}-retry` });

  const run = async (consumer: Consumer, topic: string, honourDelay: boolean): Promise<void> => {
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    await consumer.run({
      eachMessage: async (payload) => {
        if (honourDelay) {
          const notBefore = header(payload, NOT_BEFORE_HEADER);
          const waitMs = notBefore === null ? 0 : Date.parse(notBefore) - Date.now();
          if (waitMs > 0) {
            // ⚠ KAFKA DELAYS NOTHING, so the wait happens here — and returning
            //   without seeking would COMMIT the offset and lose the message.
            //   Pause, seek back to this very offset, resume when due: the
            //   partition stalls, which is what a retry topic is for, and the
            //   main topic keeps moving because it is a different consumer.
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

        const disposition = await dispatch(dataSource, producer, Service.NOTIFICATIONS, payload);
        console.log(`${payload.topic} ${disposition}`);
      },
    });
  };

  await run(main, SOURCE_TOPIC, false);
  await run(retries, retryTopic(Service.NOTIFICATIONS), true);

  // ⚠ LEAVE THE GROUP ON THE WAY OUT. A consumer killed without disconnecting
  //   stays a member until its session times out, and the group sits in
  //   PreparingRebalance for that whole time — during which the REPLACEMENT
  //   consumer joins and consumes nothing. In a rolling deploy that is a stall
  //   at every pod, and it looks like a broker problem rather than a missing
  //   four lines.
  const shutdown = async (): Promise<void> => {
    await Promise.allSettled([main.disconnect(), retries.disconnect(), producer.disconnect()]);
    await dataSource.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  console.log(
    `notifications: consuming ${SOURCE_TOPIC}, retrying on ${retryTopic(Service.NOTIFICATIONS)}, dead-lettering to ${deadLetterTopic(Service.NOTIFICATIONS)}`,
  );
}

await main();
