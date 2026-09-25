import 'reflect-metadata';

import { deadLetterTopic, retryTopic, runConsumers } from '@arthome-platform/messaging';
import { Kafka } from 'kafkajs';

import { applyMessage } from './consumer/show-consumer.js';
import { dataSource } from './data-source.js';
import { env } from './env.js';
import { createOpenSearchClient, ensureShowIndex, showIndex } from './index/opensearch-client.js';

/**
 * ⚠ The consumer group and topic stem, owned by `infra/kafka/topics.json` and
 *   `infra/postgres/init-databases.sql`: changing it here alone names a retry topic and
 *   a database that do not exist.
 */
const SEARCH = 'search';

/** Declared in `infra/kafka/topics.json`, 3 partitions, keyed by show id. */
const SOURCE_TOPIC = 'arthome.catalog.show';

async function main(): Promise<void> {
  await dataSource.initialize();

  const opensearch = createOpenSearchClient(env.OPENSEARCH_URL);
  // ⚠ Before the first message, never lazily: a write to a missing index auto-creates it
  //   with a mapping OpenSearch guesses from the first document.
  await ensureShowIndex(opensearch);

  const kafka = new Kafka({
    clientId: SEARCH,
    // Copied: KafkaJS declares `brokers` mutable, the parsed config is not.
    brokers: [...env.KAFKA_BROKERS],
  });

  const producer = kafka.producer();
  await producer.connect();

  const index = showIndex(opensearch);

  const stop = await runConsumers({
    kafka,
    producer,
    service: SEARCH,
    sources: [
      { topic: SOURCE_TOPIC, handler: (payload) => applyMessage(dataSource, index, payload) },
    ],
    onDisposition: (topic, disposition) => console.log(`${topic} ${disposition}`),
  });

  // ⚠ THE CONSUMERS STOP FIRST. Closing the database or the index client under a
  //   mid-message handler dead-letters the work a clean shutdown was meant to spare.
  // ⚠ The guard matters because SIGTERM arrives twice — an orchestrator past its grace
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
    `search-indexer: consuming ${SOURCE_TOPIC}, retrying on ${retryTopic(SEARCH)}, dead-lettering to ${deadLetterTopic(SEARCH)}`,
  );
}

await main();
