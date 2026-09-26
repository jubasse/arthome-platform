#!/usr/bin/env node
// The operational checks for any service, including the two consumers that serve no HTTP and so
// have no readiness route to carry them. Read-only; exits 1 when anything is degraded, so a cron
// entry or a CI step can alert on it.
//
//   Usage: NODE_ENV=development node tools/ops-check.mjs <service>

import { Kafka } from 'kafkajs';

import { readKafkaBrokers } from '@arthome-platform/config';
import {
  checkDeadLetterDepth,
  checkOutboxRetention,
  checkProcessedMessageRetention,
  checkPublicationScope,
  checkReplicationSlot,
  checkUnpublishedOutbox,
  deadLetterTopic,
  outboxSlotName,
  readPublishedMessageIds,
} from '@arthome-platform/messaging';

const PUBLISHERS = new Set(['identity', 'catalog']);
// The search indexer's topics are `arthome.search.*`, not `arthome.search-indexer.*`: its
// consumer group is named for the index, and main.ts records why.
const CONSUMERS = new Map([
  ['notifications', 'notifications'],
  ['search-indexer', 'search'],
]);

const [service] = process.argv.slice(2);
if (!PUBLISHERS.has(service) && !CONSUMERS.has(service)) {
  console.error(
    `usage: node tools/ops-check.mjs <${[...PUBLISHERS, ...CONSUMERS.keys()].join('|')}>`,
  );
  process.exit(2);
}

const kafka = new Kafka({ clientId: 'ops-check', brokers: [...readKafkaBrokers()], logLevel: 0 });

const { dataSource } = await import(`../apps/${service}/dist/data-source.js`);
// Quiets development's query echo. TypeORM rebuilds the logger only for a truthy option, so
// `logging: false` alone is a no-op.
dataSource.setOptions({ logger: 'advanced-console', logging: false });
await dataSource.initialize();

const results = [];
try {
  if (PUBLISHERS.has(service)) {
    const slot = outboxSlotName(service);
    results.push(await checkReplicationSlot(dataSource, slot));
    results.push(await checkPublicationScope(dataSource, slot));
    results.push(await checkOutboxRetention(dataSource));
    results.push(
      await checkUnpublishedOutbox(dataSource, (topic) => readPublishedMessageIds(kafka, topic)),
    );
  }

  if (CONSUMERS.has(service)) {
    results.push(await checkProcessedMessageRetention(dataSource));
    const admin = kafka.admin();
    await admin.connect();
    try {
      results.push(await checkDeadLetterDepth(admin, deadLetterTopic(CONSUMERS.get(service))));
    } finally {
      await admin.disconnect();
    }
  }
} finally {
  await dataSource.destroy();
}

for (const { name, status, detail } of results) {
  console.log(`${status.padEnd(9)} ${name.padEnd(28)} ${JSON.stringify(detail)}`);
}
process.exit(results.every(({ status }) => status === 'up') ? 0 : 1);
