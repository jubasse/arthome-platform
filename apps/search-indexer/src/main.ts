import 'reflect-metadata';

import { deadLetterTopic, retryTopic, runConsumers } from '@arthome-platform/messaging';
import { Kafka } from 'kafkajs';

import { applyDateMessage } from './consumer/date-consumer.js';
import { applyShowMessage } from './consumer/show-consumer.js';
import { dataSource } from './data-source.js';
import { env } from './env.js';
import { createOpenSearchClient, ensureIndices, indicesOf } from './index/opensearch-client.js';

/**
 * The consumer group and topic stem, owned by `infra/kafka/topics.json` and
 *   `infra/postgres/init-databases.sql`: changing it here alone names a retry topic and
 *   a database that do not exist.
 */
const SEARCH = 'search';

/** Declared in `infra/kafka/topics.json`: shows keyed by show id, dates by date id. */
const SHOW_TOPIC = 'arthome.catalog.show';
const DATE_TOPIC = 'arthome.catalog.date';

async function main(): Promise<void> {
  await dataSource.initialize();

  const opensearch = createOpenSearchClient(env.OPENSEARCH_URL);
  // Before the first message, never lazily: a write to a missing index auto-creates it
  //   with a mapping OpenSearch guesses from the first document.
  await ensureIndices(opensearch);

  const kafka = new Kafka({
    clientId: SEARCH,
    // Copied: KafkaJS declares `brokers` mutable, the parsed config is not.
    brokers: [...env.KAFKA_BROKERS],
  });

  const producer = kafka.producer();
  await producer.connect();

  const indices = indicesOf(opensearch);

  const stop = await runConsumers({
    kafka,
    producer,
    service: SEARCH,
    sources: [
      { topic: SHOW_TOPIC, handler: (payload) => applyShowMessage(dataSource, indices, payload) },
      { topic: DATE_TOPIC, handler: (payload) => applyDateMessage(dataSource, indices, payload) },
    ],
    onDisposition: (topic, disposition) => console.log(`${topic} ${disposition}`),
  });

  // THE CONSUMERS STOP FIRST. Closing the database or the index client under a
  //   mid-message handler dead-letters the work a clean shutdown was meant to spare.
  // The guard matters because SIGTERM arrives twice — an orchestrator past its grace
  //   period, or ctrl-c twice — and the second re-enters into clients already closing.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    await stop();
    await producer.disconnect();
    await opensearch.close();
    await dataSource.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  console.log(
    `search-indexer: consuming ${SHOW_TOPIC} and ${DATE_TOPIC}, retrying on ${retryTopic(SEARCH)}, dead-lettering to ${deadLetterTopic(SEARCH)}`,
  );
}

await main();
