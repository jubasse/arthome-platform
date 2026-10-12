import {
  ReplayPolicy as WireReplayPolicy,
  ReplayState as WireReplayState,
} from '@arthome-platform/events';
import {
  deadLetterTopic,
  retryTopic,
  Outcome,
  runConsumers,
  type Disposition,
} from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  createTopics,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  FixedClock,
  ReplayAccessOrigin,
  ReplayAccessRevocationReason,
  ReplayPolicy,
  ReplayState,
  SeatState,
  Service,
} from '@arthome/core';

import { RecordReplayStateHandler } from './record-replay-state.handler.js';
import { ReplayAccessRow } from './replay-access.entity.js';
import { ReplayWindowRow } from './replay-window.entity.js';
import { CLOCK } from '../clock.js';
import { CATALOG_DATE_TOPIC } from '../consumer.module.js';
import { ApplyCatalogDateFactHandler } from '../date-sales/apply-catalog-date-fact.handler.js';
import { applyCatalogDateMessage } from '../date-sales/catalog-date-messages.js';
import {
  delivered,
  drafted,
  replayStateChanged,
  type CatalogMessage,
} from '../itest/catalog-messages.js';
import {
  gateInserts,
  holdAdvisoryLock,
  untilWaitingOnAdvisoryLock,
  untilWaitingOnRowLock,
  withoutRowLockWait,
} from '../itest/locks.js';
import { seedPaidOrders } from '../itest/paid-orders.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/**
 * `catalog.replay.state_changed.v1` through a real broker into a real Postgres (HANDOVER §0r):
 * the grant at `pending`, once, ordered by the `Replay`'s version, and the revocation.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;
const BOUND_CASE_MS = 120_000;
/**
 * A smoke guard only: the one-second budget (RT1 §6.10) is met on a quiet host, and a wall clock
 *   under load measures the machine; the shape is proved by counting statements.
 */
const SMOKE_BOUND_MS = 5_000;

const GRANT_GATE = 4_242_301;

const CHANNEL = 'channel-replay-itest';
const NOW = '2026-10-11T08:00:00.000Z';
const PAID_AT = '2026-10-01T10:00:00.000Z';

let stack: StartedStack;
let dataSource: DataSource;
let cqrs: TestingModule;
let commands: CommandBus;
let kafka: Kafka;
let producer: Producer;
let stopConsumers: () => Promise<void> = () => Promise.resolve();
const dispositions: Disposition[] = [];

async function dispositionOf(message: CatalogMessage, timeoutMs = 30_000): Promise<Disposition> {
  const seen = dispositions.length;
  await producer.send({ topic: CATALOG_DATE_TOPIC, messages: [message] });
  const deadline = Date.now() + timeoutMs;
  while (dispositions.length === seen) {
    if (Date.now() > deadline) throw new Error(`no disposition within ${String(timeoutMs)} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const next = dispositions[seen];
  if (next === undefined) throw new Error('no disposition');
  return next;
}

/** A drafted date with paid orders of these many seats, all active; its seat ids in order. */
async function dateWithSeats(
  dateId: string,
  series: string,
  quantities: readonly number[],
): Promise<string[]> {
  expect(await dispositionOf(drafted(dateId, CHANNEL, PAID_AT))).toBe(Outcome.APPLIED);
  await seedPaidOrders(dataSource, {
    dateId,
    channelId: CHANNEL,
    series,
    quantities,
    accountId: null,
    cancelDeadline: null,
    paidAt: PAID_AT,
  });
  const seats = await dataSource.query<{ id: string }[]>(
    `SELECT id FROM seat WHERE date_id = $1 ORDER BY id`,
    [dateId],
  );
  return seats.map(({ id }) => id);
}

/** Every statement `work` sends, through the transactions' query runners. */
async function counted<T>(
  work: () => Promise<T>,
): Promise<{ result: T; statements: number; elapsedMs: number }> {
  let statements = 0;
  const createQueryRunner = dataSource.createQueryRunner.bind(dataSource);
  const spy = vi.spyOn(dataSource, 'createQueryRunner').mockImplementation((mode) => {
    const runner = createQueryRunner(mode);
    const query = runner.query.bind(runner);
    runner.query = ((...args: Parameters<typeof query>) => {
      statements += 1;
      return query(...args);
    }) as typeof runner.query;
    return runner;
  });
  const startedAt = performance.now();
  try {
    const result = await work();
    return { result, statements, elapsedMs: performance.now() - startedAt };
  } finally {
    spy.mockRestore();
  }
}

const ENDED_SEAT = `UPDATE seat SET state = $2, ended_at = now() WHERE id = $1`;

function accessesOf(dateId: string): Promise<ReplayAccessRow[]> {
  return dataSource.getRepository(ReplayAccessRow).find({
    where: { date_id: dateId },
    order: { seat_id: 'ASC' },
  });
}

function windowOf(dateId: string): Promise<ReplayWindowRow | null> {
  return dataSource.getRepository(ReplayWindowRow).findOneBy({ date_id: dateId });
}

const pending = (dateId: string, version = 1n, policy = WireReplayPolicy.INCLUDED) =>
  replayStateChanged(dateId, { toState: WireReplayState.PENDING, version, policy });

const ONLINE_AT = '2026-10-11T06:00:00.000Z';

const online = (dateId: string, version: bigint) =>
  replayStateChanged(dateId, { toState: WireReplayState.ONLINE, version, onlineAt: ONLINE_AT });

/**
 * `first`'s transaction held open in its grant, the window's row inserted and uncommitted, until
 *   `second`, as a retry topic's consumer would send it beside the main topic's, waits on that row.
 */
async function raced(
  dateId: string,
  first: CatalogMessage,
  second: CatalogMessage,
): Promise<[Outcome, Outcome]> {
  const ungate = await gateInserts(dataSource, {
    name: 'itest_replay_grant_gate',
    table: dataSource.getMetadata(ReplayAccessRow).tableName,
    when: `NEW.date_id = '${dateId}'`,
    key: GRANT_GATE,
  });
  try {
    const release = await holdAdvisoryLock(dataSource, GRANT_GATE);
    let firstApplied: Promise<Outcome>;
    let secondApplied: Promise<Outcome>;
    try {
      firstApplied = applyCatalogDateMessage(commands, delivered(first));
      await untilWaitingOnAdvisoryLock(dataSource);
      secondApplied = applyCatalogDateMessage(commands, delivered(second));
      await untilWaitingOnRowLock(dataSource);
    } finally {
      await release();
    }
    return await Promise.all([firstApplied, secondApplied]);
  } finally {
    await ungate();
  }
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, kafka: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_replay_access_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  cqrs = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      TicketingTransactions,
      ApplyCatalogDateFactHandler,
      RecordReplayStateHandler,
      { provide: DataSource, useValue: dataSource },
      { provide: CLOCK, useValue: new FixedClock(NOW) },
    ],
  }).compile();
  await cqrs.init();
  commands = cqrs.get(CommandBus);

  kafka = new Kafka({
    clientId: 'ticketing-replay-access-itest',
    brokers: [...stack.kafka.brokers],
    logLevel: logLevel.NOTHING,
  });
  await createTopics(kafka, [
    { topic: CATALOG_DATE_TOPIC, partitions: 12 },
    { topic: retryTopic(Service.TICKETING), partitions: 3 },
    { topic: deadLetterTopic(Service.TICKETING), partitions: 3 },
  ]);
  producer = kafka.producer();
  await producer.connect();
  stopConsumers = await runConsumers({
    kafka,
    producer,
    service: Service.TICKETING,
    sources: [
      {
        topic: CATALOG_DATE_TOPIC,
        handler: (payload) => applyCatalogDateMessage(commands, payload),
      },
    ],
    onDisposition: (_topic, disposition) => dispositions.push(disposition),
  });
}, STARTUP_MS);

afterAll(async () => {
  await stopConsumers();
  await producer?.disconnect();
  await cqrs?.close();
  await dataSource?.destroy();
  await stack?.stop();
});

describe('the included replay accesses', () => {
  it(
    'a pending replay of an included date gives every active seat one access, and none to a cancelled or refunded seat',
    async () => {
      const dateId = '01a0f500-0000-7000-8000-000000000001';
      const [cancelled, refunded, ...active] = await dateWithSeats(dateId, '01a0f501', [2, 1, 1]);
      await dataSource.query(ENDED_SEAT, [cancelled, SeatState.CANCELLED]);
      await dataSource.query(ENDED_SEAT, [refunded, SeatState.REFUNDED]);

      expect(await dispositionOf(pending(dateId))).toBe(Outcome.APPLIED);

      const accesses = await accessesOf(dateId);
      expect(accesses.map(({ seat_id }) => seat_id)).toEqual(active);
      for (const access of accesses) {
        expect(access).toMatchObject({
          origin: ReplayAccessOrigin.SEAT,
          granted_at: new Date(NOW),
          revoked_at: null,
          revocation_reason: null,
        });
      }
      expect(await windowOf(dateId)).toMatchObject({
        state: ReplayState.PENDING,
        version: '1',
        granted_at: new Date(NOW),
        revoked_at: null,
      });
    },
    CASE_MS,
  );

  it(
    'the same message twice, or a second pending, adds nothing',
    async () => {
      const dateId = '01a0f500-0000-7000-8000-000000000002';
      const seats = await dateWithSeats(dateId, '01a0f502', [2, 1]);
      const first = pending(dateId);

      expect(await dispositionOf(first)).toBe(Outcome.APPLIED);
      expect(await dispositionOf(first)).toBe(Outcome.DUPLICATE);
      expect(await dispositionOf(pending(dateId))).toBe(Outcome.SUPERSEDED);

      expect(await accessesOf(dateId)).toHaveLength(seats.length);
    },
    CASE_MS,
  );

  it(
    'an online replay overtaking its pending grants once, and the late pending is superseded',
    async () => {
      const dateId = '01a0f500-0000-7000-8000-000000000003';
      const seats = await dateWithSeats(dateId, '01a0f503', [3]);
      const onlineAt = '2026-10-11T06:00:00.000Z';

      expect(
        await dispositionOf(
          replayStateChanged(dateId, { toState: WireReplayState.ONLINE, version: 2n, onlineAt }),
        ),
      ).toBe(Outcome.APPLIED);
      expect(await dispositionOf(pending(dateId))).toBe(Outcome.SUPERSEDED);

      expect(await accessesOf(dateId)).toHaveLength(seats.length);
      expect(await windowOf(dateId)).toMatchObject({
        state: ReplayState.ONLINE,
        version: '2',
        online_at: new Date(onlineAt),
        granted_at: new Date(NOW),
      });
    },
    CASE_MS,
  );

  it(
    'a withdrawn replay revokes every access of the date with its reason',
    async () => {
      const dateId = '01a0f500-0000-7000-8000-000000000004';
      const seats = await dateWithSeats(dateId, '01a0f504', [2, 2]);
      expect(await dispositionOf(pending(dateId))).toBe(Outcome.APPLIED);

      expect(
        await dispositionOf(
          replayStateChanged(dateId, { toState: WireReplayState.WITHDRAWN, version: 2n }),
        ),
      ).toBe(Outcome.APPLIED);
      expect(await dispositionOf(pending(dateId, 1n))).toBe(Outcome.SUPERSEDED);

      const accesses = await accessesOf(dateId);
      expect(accesses).toHaveLength(seats.length);
      for (const access of accesses) {
        expect(access).toMatchObject({
          revoked_at: new Date(NOW),
          revocation_reason: ReplayAccessRevocationReason.REPLAY_WITHDRAWN,
        });
      }
      expect(await windowOf(dateId)).toMatchObject({
        state: ReplayState.WITHDRAWN,
        revoked_at: new Date(NOW),
      });
    },
    CASE_MS,
  );

  it(
    'a unit-only date gets no access',
    async () => {
      const dateId = '01a0f500-0000-7000-8000-000000000005';
      await dateWithSeats(dateId, '01a0f505', [2]);

      expect(await dispositionOf(pending(dateId, 1n, WireReplayPolicy.UNIT))).toBe(Outcome.APPLIED);

      expect(await accessesOf(dateId)).toEqual([]);
      expect(await windowOf(dateId)).toMatchObject({
        policy: ReplayPolicy.UNIT,
        granted_at: null,
      });
    },
    CASE_MS,
  );

  it(
    'a seat refunded during the grant is left with an access its seat makes invalid',
    async () => {
      const dateId = '01a0f500-0000-7000-8000-000000000006';
      const seats = await dateWithSeats(dateId, '01a0f506', [1, 1]);
      const [refunding] = seats;
      if (refunding === undefined) throw new Error('no seat');

      // A refund's transaction, holding the order's and the date's rows as the money paths do.
      const refund = dataSource.createQueryRunner();
      await refund.connect();
      await refund.startTransaction();
      try {
        await refund.query(
          `SELECT id FROM seat_order WHERE id = (SELECT order_id FROM seat WHERE id = $1)
              FOR UPDATE`,
          [refunding],
        );
        await refund.query(`SELECT date_id FROM date_sales WHERE date_id = $1 FOR UPDATE`, [
          dateId,
        ]);
        await refund.query(ENDED_SEAT, [refunding, SeatState.REFUNDED]);

        expect(await withoutRowLockWait(dataSource, dispositionOf(pending(dateId)))).toBe(
          Outcome.APPLIED,
        );
        await refund.commitTransaction();
      } catch (error) {
        await refund.rollbackTransaction();
        throw error;
      } finally {
        await refund.release();
      }

      expect((await accessesOf(dateId)).map(({ seat_id }) => seat_id)).toEqual(seats);
      const [seat] = await dataSource.query<{ state: SeatState }[]>(
        `SELECT state FROM seat WHERE id = $1`,
        [refunding],
      );
      expect(seat?.state).toBe(SeatState.REFUNDED);
    },
    CASE_MS,
  );

  it(
    'two facts of one date at the same time grant once, and the higher version is kept',
    async () => {
      const overtaken = '01a0f500-0000-7000-8000-000000000009';
      const overtaking = '01a0f500-0000-7000-8000-000000000010';
      const overtakenSeats = await dateWithSeats(overtaken, '01a0f509', [2, 1]);
      const overtakingSeats = await dateWithSeats(overtaking, '01a0f510', [2, 1]);

      expect(await raced(overtaken, pending(overtaken, 1n), online(overtaken, 2n))).toEqual([
        Outcome.APPLIED,
        Outcome.APPLIED,
      ]);
      expect(await raced(overtaking, online(overtaking, 2n), pending(overtaking, 1n))).toEqual([
        Outcome.APPLIED,
        Outcome.SUPERSEDED,
      ]);

      for (const [dateId, seats] of [
        [overtaken, overtakenSeats],
        [overtaking, overtakingSeats],
      ] as const) {
        expect((await accessesOf(dateId)).map(({ seat_id }) => seat_id)).toEqual(seats);
        expect(await windowOf(dateId)).toMatchObject({
          state: ReplayState.ONLINE,
          version: '2',
          online_at: new Date(ONLINE_AT),
          granted_at: new Date(NOW),
          revoked_at: null,
        });
      }
    },
    CASE_MS,
  );

  it(
    'grants 50 or 5,000 seats in the same statements, within a smoke bound',
    async () => {
      const few = '01a0f500-0000-7000-8000-000000000007';
      const many = '01a0f500-0000-7000-8000-000000000008';
      await dateWithSeats(
        few,
        '01a0f507',
        Array.from({ length: 10 }, () => 5),
      );
      await dateWithSeats(
        many,
        '01a0f508',
        Array.from({ length: 1_000 }, () => 5),
      );

      const grantFew = await counted(() =>
        applyCatalogDateMessage(commands, delivered(pending(few))),
      );
      const grantMany = await counted(() =>
        applyCatalogDateMessage(commands, delivered(pending(many))),
      );

      console.warn(
        `granted 50 accesses in ${grantFew.elapsedMs.toFixed(0)} ms, ` +
          `5,000 in ${grantMany.elapsedMs.toFixed(0)} ms`,
      );
      expect([grantFew.result, grantMany.result]).toEqual([Outcome.APPLIED, Outcome.APPLIED]);
      expect(await accessesOf(few)).toHaveLength(50);
      expect(await accessesOf(many)).toHaveLength(5_000);
      expect(grantFew.statements).toBeGreaterThan(0);
      expect(grantMany.statements).toBe(grantFew.statements);
      expect(grantMany.elapsedMs).toBeLessThan(SMOKE_BOUND_MS);
    },
    BOUND_CASE_MS,
  );
});
