/**
 * `startStack` itself: both containers at once, which is the shape a service's
 * own integration test will have.
 *
 * ⚠ NAMED `.itest.ts`, for the reason given in `index.ts`: `pnpm run verify`
 *   collects `*.spec.*` and `*.test.*`, and a container start inside the commit
 *   gate is how the gate stops being run.
 */

import { Kafka, logLevel } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDatabase } from './database.js';
import { startStack, type StartedStack } from './stack.js';

const STARTUP_BUDGET_MS = 300_000;
const TEST_BUDGET_MS = 60_000;

/** The ports `compose.yaml` publishes, which this harness must never take. */
const DEVELOPMENT_POSTGRES_PORT = 55432;
const DEVELOPMENT_KAFKA_PORT = 29092;

describe('startStack', () => {
  let stack: StartedStack;

  beforeAll(async () => {
    stack = await startStack({
      postgres: true,
      kafka: true,
      startupTimeoutMs: STARTUP_BUDGET_MS,
    });
  }, STARTUP_BUDGET_MS);

  afterAll(async () => {
    await stack.stop();
  }, TEST_BUDGET_MS);

  it(
    'hands back a Postgres that answers, and an empty migration plan is not an error',
    async () => {
      const target = await createDatabase(stack.postgres, 'harness_stack');
      const dataSource = await applyMigrations(target, { entities: [], migrations: [] });
      try {
        const answer = await dataSource.query<{ database: string }[]>(
          'SELECT current_database() AS database',
        );
        expect(answer[0]?.database).toBe('harness_stack');
      } finally {
        await dataSource.destroy();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    'hands back a broker that answers',
    async () => {
      const kafka = new Kafka({
        clientId: 'arthome-testing',
        brokers: [...stack.kafka.brokers],
        logLevel: logLevel.NOTHING,
      });
      const admin = kafka.admin();
      try {
        await admin.connect();
        // The call matters, not the answer: a fresh broker has no topics of its
        // own, and what is being asserted is that it replies at all.
        await expect(admin.listTopics()).resolves.toBeInstanceOf(Array);
      } finally {
        await admin.disconnect();
      }
    },
    TEST_BUDGET_MS,
  );

  it(
    'never takes the ports the development stack publishes',
    () => {
      // A harness bound to 55432 or 29092 passes alone and fails the moment
      // anybody has `docker compose up` running — which is every day, and which
      // reads as a broken test rather than as a port collision.
      expect(stack.postgres.port).not.toBe(DEVELOPMENT_POSTGRES_PORT);
      const [broker] = stack.kafka.brokers;
      expect(broker?.endsWith(`:${DEVELOPMENT_KAFKA_PORT}`)).toBe(false);
    },
    TEST_BUDGET_MS,
  );
});

describe('startStack, asked for one container only', () => {
  it(
    'refuses by name to hand back an endpoint it was never asked to start',
    async () => {
      const only = await startStack({ postgres: true, startupTimeoutMs: STARTUP_BUDGET_MS });
      try {
        expect(only.postgres.port).toBeGreaterThan(0);
        // ⚠ The alternative is a nullable field, and a test that forgot to ask
        //   would then build a connection string containing the word
        //   "undefined" and fail on a DNS error. This names the mistake.
        expect(() => only.kafka).toThrow(/was not asked for kafka/);
      } finally {
        await only.stop();
      }
    },
    STARTUP_BUDGET_MS,
  );
});
