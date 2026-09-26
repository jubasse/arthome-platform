#!/usr/bin/env node
// Finds outbox rows committed but absent from their topic, and republishes them under their
// original id. Dry run by default: `--apply` republishes, then reconciles again to prove it.
//
//   Usage: NODE_ENV=development node tools/republish-outbox.mjs <identity|catalog> [--apply]
//
// Safe even when a row did arrive after all: the id is kept, so it is the same message-id, and
// every consumer's deduplication absorbs it.

import { Kafka } from 'kafkajs';

import { readKafkaBrokers } from '@arthome-platform/config';
import {
  findUnpublishedOutboxRows,
  readPublishedMessageIds,
  republishOutboxRow,
} from '@arthome-platform/messaging';

const PUBLISHERS = new Set(['identity', 'catalog']);

const [service, ...flags] = process.argv.slice(2);
if (!PUBLISHERS.has(service)) {
  console.error(`usage: node tools/republish-outbox.mjs <${[...PUBLISHERS].join('|')}> [--apply]`);
  process.exit(2);
}
const apply = flags.includes('--apply');

const kafka = new Kafka({
  clientId: 'republish-outbox',
  brokers: [...readKafkaBrokers()],
  logLevel: 0,
});
const readIds = (topic) => readPublishedMessageIds(kafka, topic);

const { dataSource } = await import(`../apps/${service}/dist/data-source.js`);
// Same logger rebuild as ops-check.mjs: `logging: false` alone is a no-op.
dataSource.setOptions({ logger: 'advanced-console', logging: false });
await dataSource.initialize();

try {
  const { checked, unpublished } = await findUnpublishedOutboxRows(dataSource, readIds);
  console.log(`${service}: ${checked} row(s) checked, ${unpublished.length} never published`);
  for (const row of unpublished) {
    console.log(`  ${row.id}  ${row.type}  ${row.aggregateId}  ${row.createdAt.toISOString()}`);
  }

  if (!apply || unpublished.length === 0) process.exitCode = unpublished.length === 0 ? 0 : 1;
  else {
    for (const { id } of unpublished) await republishOutboxRow(dataSource, id);
    console.log(`republished ${unpublished.length}; waiting for the connector to carry them…`);
    await new Promise((resolve) => setTimeout(resolve, 8_000));

    const after = await findUnpublishedOutboxRows(dataSource, readIds);
    console.log(`after: ${after.unpublished.length} still unpublished`);
    process.exitCode = after.unpublished.length === 0 ? 0 : 1;
  }
} finally {
  await dataSource.destroy();
}
