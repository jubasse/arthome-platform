/**
 * The harness, proved against a real Postgres 18.
 *
 * ⚠ NAMED `.itest.ts` AND NOT `.spec.ts`. `pnpm run verify` ends in `vitest
 *   run`, whose default patterns are `*.spec.*` and `*.test.*`. This file starts
 *   a container: inside the gate it would make every commit depend on a Docker
 *   daemon and on half a minute of startup, and a gate that costs that much is a
 *   gate people stop running. Run it with `pnpm --filter
 *   @arthome-platform/testing run test:integration`.
 *
 * What it is actually for: `outboxTableDdl` and its CHECK constraints are the
 * only thing standing between a service and the worst failure this platform has
 * — a row whose `aggregatetype` is not topic-safe kills the Debezium task, stops
 * every later event from that service, and is recovered only by deleting a
 * committed business fact. No unit test can say whether those constraints hold,
 * because the thing being asserted is Postgres's behaviour.
 */

import { randomUUID } from 'node:crypto';

import { OutboxEvent, outboxTableDdl, writeOutboxEvent } from '@arthome-platform/messaging';
import type { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations, createDatabase, truncateAll } from './database.js';
import { startPostgres, type StartedPostgres } from './stack.js';

/** A first run pulls the image; after that it is seconds. */
const STARTUP_BUDGET_MS = 300_000;
const TEST_BUDGET_MS = 60_000;

/**
 * Not named after a service. `identity`, `notifications` and the others are
 * members of `SERVICES` in @arthome/core, and a literal copy of one is what
 * `check-enums` exists to refuse.
 */
const DATABASE = 'harness_outbox';

/** Topic-safe, versioned, and belonging to no bounded context. */
const AGGREGATE_TYPE = 'harness.probe';
const EVENT_TYPE = 'harness.probe.happened.v1';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

/**
 * The outbox alone, created from the DDL the seven services share.
 *
 * Running it here is the point: `outboxTableDdl` is a template string, so
 * nothing but a real `CREATE TABLE` can say whether it is valid SQL, whether the
 * regular expressions survive being embedded in it, and whether the constraints
 * it names are the ones a violation reports.
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
    // Destroy the pool before stopping the container: a live pool keeps the Node
    // process alive, and a runner that will not exit looks like a hung test.
    await dataSource.destroy();
    await postgres.stop();
  }, TEST_BUDGET_MS);

  beforeEach(async () => {
    await truncateAll(dataSource);
  });

  it(
    'reproduces the wal_level the connector needs, not the default',
    async () => {
      // The whole event path rests on this, and at `replica` there is simply
      // nothing in the write-ahead log for Debezium to read. A harness that
      // quietly ran the default would make every future CDC test a false
      // negative.
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
      // ⚠ The message id is NOT the aggregate's. Reusing the aggregate id would
      //   make a second event about the same object look like a duplicate of the
      //   first, and every consumer would silently drop it.
      expect(rows[0]?.id).not.toBe(aggregateId);
      expect(rows[0]?.aggregateid).toBe(aggregateId);
      expect(rows[0]?.aggregatetype).toBe(AGGREGATE_TYPE);
      // Injected at write time, inside the request that caused the fact. Injected
      // by the relay instead, it would be a context that no longer exists.
      expect(rows[0]?.tracecontext).toBe(TRACEPARENT);
      expect(rows[0]?.payload.equals(payload)).toBe(true);
    },
    TEST_BUDGET_MS,
  );

  it(
    'refuses, inside the transaction, the row that would kill the connector',
    async () => {
      // A space here becomes an InvalidTopicException in the producer's send
      // callback, past `errors.tolerance` and past a dead-letter queue a SOURCE
      // connector does not have. The task dies, every later event from the
      // service stops, and the replication slot retains the write-ahead log
      // until the disk is full. Refusing it here refuses it while a request is
      // still waiting to be told.
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
      // ⚠ The migration record has to survive. Truncated, it tells TypeORM that
      //   nothing has ever run, and the next `runMigrations` replays CREATE TABLE
      //   against a schema that still has the table.
      const applied = await dataSource.query<{ name: string }[]>('SELECT name FROM migrations');
      expect(applied.map((row) => row.name)).toContain('OutboxOnly1758700000000');
    },
    TEST_BUDGET_MS,
  );
});
