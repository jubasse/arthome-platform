/**
 * The harness, proved against a real Postgres 18.
 *
 * `outboxTableDdl`'s CHECK constraints are all that stands between a service and
 * a row whose `aggregatetype` is not topic-safe, which kills the Debezium task,
 * stops every later event from that service, and is recovered only by deleting a
 * committed business fact. Only Postgres can say whether they hold.
 */

import { randomUUID } from 'node:crypto';

import { OutboxEvent, outboxTableDdl, writeOutboxEvent } from '@arthome-platform/messaging';
import type { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations, createDatabase, truncateAll } from './database.js';
import { startPostgres, type StartedPostgres } from './stack.js';

const STARTUP_BUDGET_MS = 300_000;
const TEST_BUDGET_MS = 60_000;

// Not named after a service: those names belong to `SERVICES` in @arthome/core.
const DATABASE = 'harness_outbox';

const AGGREGATE_TYPE = 'harness.probe';
const EVENT_TYPE = 'harness.probe.happened.v1';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

/**
 * `outboxTableDdl` is a template string, so only a real `CREATE TABLE` can say
 * whether the regular expressions survive being embedded in it.
 */
class OutboxOnly1758700000000 implements MigrationInterface {
  name = 'OutboxOnly1758700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(outboxTableDdl());
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE outbox_event');
  }
}

describe('the outbox, against a real Postgres', () => {
  let postgres: StartedPostgres;
  let dataSource: DataSource;

  beforeAll(async () => {
    postgres = await startPostgres(STARTUP_BUDGET_MS);
    const target = await createDatabase(postgres.endpoint, DATABASE);
    dataSource = await applyMigrations(target, {
      entities: [OutboxEvent],
      migrations: [OutboxOnly1758700000000],
    });
  }, STARTUP_BUDGET_MS);

  afterAll(async () => {
    // Before stopping the container: a live pool keeps the Node process alive.
    await dataSource.destroy();
    await postgres.stop();
  }, TEST_BUDGET_MS);

  beforeEach(async () => {
    await truncateAll(dataSource);
  });

  it(
    'reproduces the wal_level the connector needs, not the default',
    async () => {
      const shown = await dataSource.query<{ wal_level: string }[]>('SHOW wal_level');
      expect(shown[0]?.wal_level).toBe('logical');
    },
    TEST_BUDGET_MS,
  );

  it(
    'records a fact through the caller transaction, under a message id of its own',
    async () => {
      const aggregateId = randomUUID();
      const payload = Buffer.from('{"probe":true}', 'utf8');

      const messageId = await dataSource.transaction((manager) =>
        writeOutboxEvent(manager, {
          aggregateType: AGGREGATE_TYPE,
          aggregateId,
          type: EVENT_TYPE,
          payload,
          traceparent: TRACEPARENT,
          actorId: null,
        }),
      );

      const rows = await dataSource.getRepository(OutboxEvent).find();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(messageId);
      // The message id is NOT the aggregate's: reused, a second event about the
      //   same object looks like a duplicate and every consumer drops it.
      expect(rows[0]?.id).not.toBe(aggregateId);
      expect(rows[0]?.aggregateid).toBe(aggregateId);
      expect(rows[0]?.aggregatetype).toBe(AGGREGATE_TYPE);
      // Injected at write time; the relay would inject a context that is gone.
      expect(rows[0]?.tracecontext).toBe(TRACEPARENT);
      expect(rows[0]?.payload.equals(payload)).toBe(true);
    },
    TEST_BUDGET_MS,
  );

  it(
    'refuses, inside the transaction, the row that would kill the connector',
    async () => {
      // A space here becomes an InvalidTopicException past `errors.tolerance` and
      // past a DLQ a SOURCE connector does not have: the task dies and the
      // replication slot retains the write-ahead log until the disk is full.
      const refused = dataSource.transaction((manager) =>
        writeOutboxEvent(manager, {
          aggregateType: 'harness probe',
          aggregateId: randomUUID(),
          type: EVENT_TYPE,
          payload: Buffer.from('{}', 'utf8'),
          traceparent: null,
        }),
      );

      await expect(refused).rejects.toThrow(/outbox_event_aggregatetype_is_topic_safe/);
      expect(await dataSource.getRepository(OutboxEvent).count()).toBe(0);
    },
    TEST_BUDGET_MS,
  );

  it(
    'refuses a payload of zero bytes, which would decode as a fact saying nothing',
    async () => {
      const refused = dataSource.transaction((manager) =>
        writeOutboxEvent(manager, {
          aggregateType: AGGREGATE_TYPE,
          aggregateId: randomUUID(),
          type: EVENT_TYPE,
          payload: new Uint8Array(0),
          traceparent: null,
        }),
      );

      await expect(refused).rejects.toThrow(/outbox_event_payload_not_empty/);
    },
    TEST_BUDGET_MS,
  );

  it(
    'empties the tables between tests and leaves the migration record standing',
    async () => {
      await dataSource.transaction((manager) =>
        writeOutboxEvent(manager, {
          aggregateType: AGGREGATE_TYPE,
          aggregateId: randomUUID(),
          type: EVENT_TYPE,
          payload: Buffer.from('{}', 'utf8'),
          traceparent: null,
        }),
      );

      await truncateAll(dataSource);

      expect(await dataSource.getRepository(OutboxEvent).count()).toBe(0);
      // Truncated, it tells TypeORM nothing has ever run and the next
      //   `runMigrations` replays CREATE TABLE against the tables it left.
      const applied = await dataSource.query<{ name: string }[]>('SELECT name FROM migrations');
      expect(applied.map((row) => row.name)).toContain('OutboxOnly1758700000000');
    },
    TEST_BUDGET_MS,
  );
});
