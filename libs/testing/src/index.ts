/**
 * The integration harness: real Postgres and real Kafka, in containers a test
 * starts and throws away.
 *
 * ⚠ AN INTEGRATION TEST IS NAMED `*.itest.ts`, NEVER `*.spec.ts`. `pnpm run
 *   verify` ends in `vitest run`, whose default patterns are `*.spec.*` and
 *   `*.test.*`, and it is the gate before every commit. Put one container start
 *   inside it and the gate needs a Docker daemon and half a minute per run —
 *   which is how a gate stops being run at all, and then stops being true. The
 *   slow suite has its own command: `pnpm --filter @arthome-platform/testing run
 *   test:integration`.
 */

export { composeImage, startKafka, startOpenSearch, startPostgres, startStack } from './stack.js';
export type {
  KafkaEndpoint,
  OpenSearchEndpoint,
  PostgresEndpoint,
  StackRequest,
  StartedKafka,
  StartedOpenSearch,
  StartedPostgres,
  StartedStack,
} from './stack.js';

export { createTopics, headersOf, waitForMessage } from './kafka.js';
export type { ObservedMessage, TopicSpec, WaitForMessageOptions } from './kafka.js';

export { applyMigrations, createDatabase, truncateAll } from './database.js';
export type { MigrationPlan } from './database.js';
