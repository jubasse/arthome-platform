import 'reflect-metadata';

import { readKafkaBrokers } from '@arthome-platform/config';
import { deadLetterTopic, retryTopic, runConsumers } from '@arthome-platform/messaging';
import { NestFactory } from '@nestjs/core';
import { CommandBus } from '@nestjs/cqrs';
import { Kafka } from 'kafkajs';

import { Service } from '@arthome/core';

import { ConsumerModule } from './consumer.module.js';
import { applyChecklistMessage } from './dates/checklist-consumer.js';

/** The facts the publication checklist projects (data-model.md §2.3), all keyed by date id. */
const SOURCE_TOPICS = [
  'arthome.ticketing.date_sales',
  'arthome.streaming.run',
  'arthome.chat.date',
];

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(ConsumerModule, {
    logger: ['warn', 'error'],
  });
  const commands = app.get(CommandBus);

  const kafka = new Kafka({ clientId: Service.CATALOG, brokers: [...readKafkaBrokers()] });
  const producer = kafka.producer();
  await producer.connect();

  const stop = await runConsumers({
    kafka,
    producer,
    service: Service.CATALOG,
    sources: SOURCE_TOPICS.map((topic) => ({
      topic,
      handler: (payload) => applyChecklistMessage(commands, payload),
    })),
    onDisposition: (topic, disposition) => console.log(`${topic} ${disposition}`),
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    await stop();
    await producer.disconnect();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  console.log(
    `catalog consumer: ${SOURCE_TOPICS.join(', ')}, retrying on ${retryTopic(Service.CATALOG)}, dead-lettering to ${deadLetterTopic(Service.CATALOG)}`,
  );
}

await main();
