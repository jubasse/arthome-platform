import { Outcome } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, RunState } from '@arthome/core';

import { PrepareRun } from './prepare-run.command.js';
import { RunConsumerModule } from './run-consumer.module.js';
import { STREAM_KEY_SECRET, streamKeyDigestOf, streamKeyOf } from './stream-key.js';
import { CLOCK } from '../clock.js';
import { STREAMING_SCHEMA } from '../itest/schema.js';

/**
 * `PrepareRun` through the consumer's module and the real bus, against Postgres: the message
 *   claimed in the transaction that prepares the run, and a second draft of the date superseded.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const TOPIC = 'arthome.catalog.date';
const DATE = '01a0f100-0000-7000-8000-000000000001';
const CHANNEL = '01a0f100-0000-7000-8000-0000000000c1';
const SECRET = 'the-prepare-run-suites-stream-key-secret';
const NOW = '2026-09-29T10:00:00.000Z';

let stack: StartedStack;
let dataSource: DataSource;
let moduleRef: TestingModule;

function messageId(n: number): string {
  return `01a0f1ee-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

function drafted(id: string, dateId: string = DATE): Promise<Outcome> {
  return moduleRef
    .get(CommandBus)
    .execute(
      new PrepareRun(
        { messageId: id, topic: TOPIC, traceparent: null },
        { dateId, channelId: CHANNEL, occurredAt: new Date(NOW) },
      ),
    );
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'streaming_prepare_run_itest');
  dataSource = await applyMigrations(database, STREAMING_SCHEMA);
  moduleRef = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRootAsync({
        useFactory: () => dataSource.options,
        dataSourceFactory: () => Promise.resolve(dataSource),
      }),
      CqrsModule.forRoot(),
      RunConsumerModule,
    ],
  })
    .overrideProvider(CLOCK)
    .useValue(new FixedClock(NOW))
    .overrideProvider(STREAM_KEY_SECRET)
    .useValue(SECRET)
    .compile();
  await moduleRef.init();
}, STARTUP_MS);

afterAll(async () => {
  await moduleRef?.close();
  await stack?.stop();
});

describe('PrepareRunHandler', () => {
  it(
    'prepares one idle run per draft, answers duplicate to its message-id, superseded to a second draft',
    async () => {
      expect(await drafted(messageId(1))).toBe(Outcome.APPLIED);
      expect(await drafted(messageId(1))).toBe(Outcome.DUPLICATE);
      expect(await drafted(messageId(2))).toBe(Outcome.SUPERSEDED);

      const runs = await dataSource.query<
        { id: string; state: string; channel_id: string; stream_path: string; version: number }[]
      >('SELECT id, state, channel_id, stream_path, version FROM run WHERE date_id = $1', [DATE]);
      expect(runs).toEqual([
        expect.objectContaining({
          state: RunState.IDLE,
          channel_id: CHANNEL,
          version: 1,
        }),
      ]);
      expect(Buffer.from(runs[0]?.stream_path ?? '', 'base64url')).toHaveLength(16);
    },
    CASE_MS,
  );

  it(
    "keeps the first key generation's digest alone, never the key",
    async () => {
      expect(await drafted(messageId(3), '01a0f100-0000-7000-8000-000000000002')).toBe(
        Outcome.APPLIED,
      );
      const [run] = await dataSource.query<{ id: string }[]>(
        'SELECT id FROM run WHERE date_id = $1',
        ['01a0f100-0000-7000-8000-000000000002'],
      );
      const keys = await dataSource.query<{ generation: number; digest: string }[]>(
        'SELECT generation, digest, retired_at FROM stream_key WHERE run_id = $1',
        [run?.id],
      );
      const key = streamKeyOf(SECRET, run?.id ?? '', 1);
      expect(keys).toEqual([{ generation: 1, digest: streamKeyDigestOf(key), retired_at: null }]);
      const everything = JSON.stringify(
        await dataSource.query('SELECT * FROM run, stream_key WHERE run.id = stream_key.run_id'),
      );
      expect(everything).not.toContain(key);
    },
    CASE_MS,
  );
});
