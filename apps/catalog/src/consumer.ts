import 'reflect-metadata';

import { readKafkaBrokers } from '@arthome-platform/config';
import { deadLetterTopic, retryTopic, runConsumers } from '@arthome-platform/messaging';
import { Kafka } from 'kafkajs';

import { Service } from '@arthome/core';

import { dataSource } from './data-source.js';
import { applyChecklistMessage } from './dates/checklist-consumer.js';

/** The facts the publication checklist projects (data-model.md §2.3), all keyed by date id. */
const SOURCE_TOPICS = [
  'arthome.ticketing.date_sales',
  'arthome.streaming.run',
  'arthome.chat.date',
];

async function main(): Promise<void> {
  await dataSource.initialize();

  const kafka = new Kafka({ clientId: Service.CATALOG, brokers: [...readKafkaBrokers()] });
  const producer = kafka.producer();
  await producer.connect();

  const stop = await runConsumers({
    kafka,
    producer,
    service: Service.CATALOG,
    sources: SOURCE_TOPICS.map((topic) => ({
      topic,
      handler: (payload) => applyChecklistMessage(dataSource, payload),
    })),
    onDisposition: (topic, disposition) => console.log(`${topic} ${disposition}`),
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    await stop();
    await producer.disconnect();
    await dataSource.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  console.log(
    `catalog consumer: ${SOURCE_TOPICS.join(', ')}, retrying on ${retryTopic(Service.CATALOG)}, dead-lettering to ${deadLetterTopic(Service.CATALOG)}`,
  );
}

await main();
