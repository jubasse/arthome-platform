import 'reflect-metadata';

import { Kafka } from 'kafkajs';

import { Service } from '@arthome/core';

import { applyMessage } from './consumer/account-consumer.js';
import { dataSource } from './data-source.js';

const TOPIC = 'arthome.identity.account';

async function main(): Promise<void> {
  await dataSource.initialize();

  // ⚠ NAMED FROM THE DOMAIN, not from a literal. `check-enums` caught both of
  //   these as copies of SERVICES, and it was right: a service's own name is a
  //   domain fact, and a typo in a groupId does not fail — it silently forms a
  //   second consumer group that reads everything again from the beginning.
  const kafka = new Kafka({
    clientId: Service.NOTIFICATIONS,
    brokers: [process.env.KAFKA_BROKERS ?? 'localhost:29092'],
  });
  // ⚠ ONE GROUP PER SERVICE, never one shared across services. A shared group
  //   makes the leader assign only its own topics and the others go unconsumed
  //   — silently (events.md §1.4).
  const consumer = kafka.consumer({ groupId: Service.NOTIFICATIONS });

  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
  await consumer.run({
    eachMessage: async (payload) => {
      const outcome = await applyMessage(dataSource, payload);
      console.log(`${payload.topic} ${outcome}`);
    },
  });
}

await main();
