import 'reflect-metadata';

import { deadLetterTopic, retryTopic, runConsumers } from '@arthome-platform/messaging';
import { Kafka } from 'kafkajs';

import { Service } from '@arthome/core';

import { applyMessage } from './consumer/account-consumer.js';
import { dataSource } from './data-source.js';

const SOURCE_TOPIC = 'arthome.identity.account';

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

  // Everything about groups, retry delays, dead-lettering and leaving the group
  // cleanly lives in @arthome-platform/messaging. A service supplies its name,
  // its topics and what to do with a message — nothing else.
  const stop = await runConsumers({
    kafka,
    producer,
    service: Service.NOTIFICATIONS,
    sources: [{ topic: SOURCE_TOPIC, handler: (payload) => applyMessage(dataSource, payload) }],
    onDisposition: (topic, disposition) => console.log(`${topic} ${disposition}`),
  });

  const shutdown = async (): Promise<void> => {
    await stop();
    await producer.disconnect();
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
