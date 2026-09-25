import 'reflect-metadata';

import { deadLetterTopic, retryTopic, runConsumers } from '@arthome-platform/messaging';
import { Kafka } from 'kafkajs';

import { applyMessage } from './consumer/show-consumer.js';
import { dataSource } from './data-source.js';
import { createOpenSearchClient, ensureShowIndex, showIndex } from './index/opensearch-client.js';

/**
 * The consumer group, the retry topic and the dead-letter topic of this
 * deployable.
 *
 * ⚠ IT IS NOT A `Service` FROM `@arthome/core`, AND IT MUST NOT BECOME ONE.
 *   `SERVICES` answers "which service does a BFF operation call" — it is what
 *   makes fan-out countable, and a name in it that nothing calls makes every
 *   upstream count wrong. Nobody calls the search indexer; it consumes a topic
 *   and writes an index. Adding it there would repeat the mistake that constant
 *   was created to catch, where `realtime` was declared as a service and anyone
 *   counting got eight out of seven.
 *
 * ⚠ THE VALUE IS OWNED BY `infra/kafka/topics.json`, which already declares
 *   `arthome.search.retry` and `arthome.search.dlq`, and by
 *   `infra/postgres/init-databases.sql`, which creates the `search` database.
 *   Changing it here without changing those two gives this service a retry
 *   topic that does not exist — and KafkaJS will not subscribe to a topic that
 *   does not exist, so it fails at startup rather than quietly.
 *
 * ⚠ AND IT IS NOT `catalog`. One consumer group per deployable, never one
 *   shared: a group whose members subscribe to different topic sets has its
 *   leader assign only its own, and the others go unconsumed — silently
 *   (events.md §1.4).
 */
const SEARCH = 'search';

/** Declared in `infra/kafka/topics.json`, 3 partitions, keyed by show id. */
const SOURCE_TOPIC = 'arthome.catalog.show';

async function main(): Promise<void> {
  await dataSource.initialize();

  const opensearch = createOpenSearchClient();
  // ⚠ BEFORE THE FIRST MESSAGE, NOT LAZILY ON THE FIRST WRITE. Writing to an
  //   index that does not exist AUTO-CREATES it, with a mapping OpenSearch
  //   guesses from the first document — which is the one outcome
  //   `show-document.ts` is written to prevent. Failing at startup is the
  //   point: a mapping that cannot be applied is a deployment that must not
  //   take traffic.
  await ensureShowIndex(opensearch);

  const kafka = new Kafka({
    clientId: SEARCH,
    brokers: [process.env.KAFKA_BROKERS ?? 'localhost:29092'],
  });

  const producer = kafka.producer();
  await producer.connect();

  const index = showIndex(opensearch);

  // Groups, retry delays, dead-lettering and leaving the group cleanly all live
  // in @arthome-platform/messaging. A service supplies its name, its topics and
  // what to do with a message — nothing else.
  const stop = await runConsumers({
    kafka,
    producer,
    service: SEARCH,
    sources: [
      { topic: SOURCE_TOPIC, handler: (payload) => applyMessage(dataSource, index, payload) },
    ],
    onDisposition: (topic, disposition) => console.log(`${topic} ${disposition}`),
  });

  // ⚠ THE CONSUMERS STOP FIRST, AND THE ORDER IS THE WHOLE VALUE OF THIS BLOCK.
  //   Closing the database or the index client while a handler is mid-message
  //   turns a clean shutdown into a failed write, which is retried and
  //   eventually dead-lettered — a deploy manufacturing the failures it was
  //   supposed to avoid. `stop()` leaves the group cleanly, which also matters:
  //   a consumer killed without disconnecting stays a member until its session
  //   times out, and its REPLACEMENT consumes nothing for that whole time.
  // ⚠ An orchestrator sends SIGTERM and then, past its grace period, again — and a
  //   person pressing ctrl-c twice does the same. Without this the second signal
  //   re-enters and calls stop() and disconnect() on clients already closing, which
  //   is how a clean shutdown ends in a rejection nobody reads.
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
