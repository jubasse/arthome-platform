/**
 * The integration harness: real Postgres and real Kafka, in containers a test
 * starts and throws away.
 *
 * An integration test is named `*.itest.ts`, never `*.spec.ts`, so that the
 *   pre-commit gate does not need a Docker daemon. Run them with
 *   `pnpm --filter @arthome-platform/testing run test:integration`.
 */

export {
  composeImage,
  startConnect,
  startKafka,
  startOpenSearch,
  startPostgres,
  startStack,
} from './stack.js';
export type {
  ConnectEndpoint,
  KafkaEndpoint,
  OpenSearchEndpoint,
  PostgresEndpoint,
  StackRequest,
  StartedConnect,
  StartedKafka,
  StartedOpenSearch,
  StartedPostgres,
  StartedStack,
} from './stack.js';

export { createTopics, headersOf, waitForMessage } from './kafka.js';
export type { ObservedMessage, TopicSpec, WaitForMessageOptions } from './kafka.js';

export { applyMigrations, createDatabase, truncateAll } from './database.js';
export type { MigrationPlan } from './database.js';
