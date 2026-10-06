import { randomUUID } from 'node:crypto';

import { OutboxEvent, outboxTableDdl, writeOutboxEvent } from '@arthome-platform/messaging';
import { Kafka, logLevel } from 'kafkajs';
import type { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Service } from '@arthome/core';

import { registerOutboxConnector } from './connector.js';
import { applyMigrations, createDatabase } from './database.js';
import { createTopics, waitForMessage } from './kafka.js';
import { startStack, type PostgresEndpoint, type StartedStack } from './stack.js';

const STARTUP_BUDGET_MS = 300_000;
const TEST_BUDGET_MS = 120_000;

// Routed by the connector's `aggregatetype` to `arthome.<aggregatetype>`.
const AGGREGATE_TYPE = 'ticketing.order';
const TOPIC = `arthome.${AGGREGATE_TYPE}`;

class OutboxOnly1758700000000 implements MigrationInterface {
  name = 'OutboxOnly1758700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(outboxTableDdl());
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE outbox_event');
  }
}

describe('registerOutboxConnector', () => {
  let stack: StartedStack;
  let suiteDatabase: PostgresEndpoint;
  let dataSource: DataSource;
  let kafka: Kafka;

  beforeAll(async () => {
    stack = await startStack({ connect: true, startupTimeoutMs: STARTUP_BUDGET_MS });
    suiteDatabase = await createDatabase(stack.postgres, 'harness_connector');
    dataSource = await applyMigrations(suiteDatabase, {
      entities: [OutboxEvent],
      migrations: [OutboxOnly1758700000000],
    });
    kafka = new Kafka({
      clientId: 'arthome-testing',
      brokers: [...stack.kafka.brokers],
      logLevel: logLevel.NOTHING,
    });
    await createTopics(kafka, [{ topic: TOPIC, partitions: 6 }]);
  }, STARTUP_BUDGET_MS);

  afterAll(async () => {
    await dataSource.destroy();
    await stack.stop();
  }, TEST_BUDGET_MS);

  it(
    "routes the suite database's outbox rows to their topic through the committed connector",
    async () => {
      const name = await registerOutboxConnector(stack.connect, Service.TICKETING, suiteDatabase);
      expect(name).toBe('ticketing-outbox');

      const aggregateId = randomUUID();
      const messageId = await dataSource.transaction((manager) =>
        writeOutboxEvent(
          manager,
          {
            aggregateType: AGGREGATE_TYPE,
            aggregateId,
            type: 'ticketing.order.paid.v1',
            payload: Buffer.from('{"probe":true}', 'utf8'),
            traceparent: null,
          },
          new Date(),
        ),
      );

      const message = await waitForMessage(kafka, {
        topic: TOPIC,
        matches: (observed) => observed.headers['message-id'] === messageId,
        timeoutMs: 60_000,
      });
      expect(message.key).toBe(aggregateId);
      expect(message.headers.type).toBe('ticketing.order.paid.v1');
    },
    TEST_BUDGET_MS,
  );
});
