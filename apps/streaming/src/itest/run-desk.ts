import { randomUUID } from 'node:crypto';

import { readInternalTokenSigningKey } from '@arthome-platform/config';
import { InternalTokenVerifier, serveEndpoints } from '@arthome-platform/http-edge';
import {
  applyMigrations,
  createDatabase,
  httpApp,
  mintInternalToken,
  startStack,
  type DeclaredResponses,
  type StartedStack,
} from '@arthome-platform/testing';
import { CommandBus } from '@nestjs/cqrs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DataSource, EntityManager } from 'typeorm';

import {
  DomainConstant,
  FixedClock,
  InternalTokenIssuer,
  PublicationState,
  ReplayPolicy,
  Service,
  Surface,
  type DateTiming,
  type Instant,
} from '@arthome/core';

import { STREAMING_SCHEMA } from './schema.js';
import { CLOCK } from '../clock.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { FakeStreamingProvider } from '../media/fake-streaming-provider.js';
import { IngestProtocol } from '../media/media-ports.js';
import { READ_DATE_FACTS, type RunDateFacts } from '../run/date-facts.js';
import { PrepareRun } from '../run/prepare-run.command.js';
import { RunConsumerModule } from '../run/run-consumer.module.js';
import { RunSweeperModule } from '../run/run-sweeper.module.js';
import { RunModule } from '../run/run.module.js';
import { STREAM_KEY_SECRET, streamKeyOf } from '../run/stream-key.js';

/**
 * The run desk's modules over HTTP on a real Postgres, as the API, the consumer and the sweeper
 *   bind them, on one `FixedClock` the fake provider shares. PS2's projection is a map a suite
 *   fills: the dates it names are projected, any other is not.
 */

export const STARTUP_MS = 240_000;
export const CASE_MS = 30_000;

export const NOW = '2026-09-29T19:00:00.000Z';
export const OPERATOR = '01a0f0aa-0000-7000-8000-000000000001';
export const CHANNEL = '01a0f0cc-0000-7000-8000-000000000001';
export const STREAM_KEY_TEST_SECRET = 'the-run-desk-suites-stream-key-secret';

/**
 * No studio BFF mints yet, so the development key set names the storefront's key alone: the
 *   suites verify the studio's tokens against that key under a studio `kid`.
 */
const STUDIO_KEY_ID = 'bff-st-run-desk-suites';
const DEVELOPMENT_KEY = readInternalTokenSigningKey({ NODE_ENV: 'test' });

function studioTokenVerifier(clock: FixedClock): InternalTokenVerifier {
  const { d: _private, kid: _kid, ...publicHalf } = DEVELOPMENT_KEY.privateJwk;
  return new InternalTokenVerifier(
    Service.STREAMING,
    {
      kind: 'local',
      keys: [
        { ...publicHalf, kid: DEVELOPMENT_KEY.keyId },
        { ...publicHalf, kid: STUDIO_KEY_ID },
      ],
    },
    clock,
  );
}

export interface RunDesk {
  readonly stack: StartedStack;
  readonly dataSource: DataSource;
  readonly app: NestFastifyApplication;
  readonly clock: FixedClock;
  readonly fake: FakeStreamingProvider;
  readonly commands: CommandBus;
  /** What PS2 projects of each date: absent means nothing projected. */
  readonly dates: Map<string, RunDateFacts>;
}

export interface PreparedRun {
  readonly dateId: string;
  readonly runId: string;
  readonly streamPath: string;
  readonly key: string;
}

export async function startRunDesk(database: string, watch?: DeclaredResponses): Promise<RunDesk> {
  const stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const created = await createDatabase(stack.postgres, database);
  const dataSource = await applyMigrations(created, STREAMING_SCHEMA);
  const clock = new FixedClock(NOW);
  const dates = new Map<string, RunDateFacts>();
  const readDateFacts = (_manager: EntityManager, dateId: string) =>
    Promise.resolve(dates.get(dateId) ?? null);
  const app = await httpApp({
    imports: [RunModule, RunConsumerModule, RunSweeperModule],
    providers: EDGE_PROVIDERS,
    dataSource,
    overrides: [
      [CLOCK, clock],
      [READ_DATE_FACTS, readDateFacts],
      [STREAM_KEY_SECRET, STREAM_KEY_TEST_SECRET],
      [InternalTokenVerifier, studioTokenVerifier(clock)],
    ],
    configure: (configured) => {
      serveEndpoints(configured);
      watch?.watch(configured);
    },
  });
  return {
    stack,
    dataSource,
    app,
    clock,
    fake: app.get(FakeStreamingProvider),
    commands: app.get(CommandBus),
    dates,
  };
}

export async function stopRunDesk(desk: RunDesk | undefined): Promise<void> {
  await desk?.app.close();
  await desk?.stack.stop();
}

/** A timing scheduled from `startsAt` for `runtimeMin`, as PS2 builds it. */
export function timingOf(startsAt: Instant, runtimeMin = 90): DateTiming {
  return {
    startsAt,
    runtimeMin,
    roomOpensBeforeMin: DomainConstant.ROOM_OPENS_MINUTES_BEFORE,
    replayPolicy: ReplayPolicy.NONE,
    replayWindowHours: 0,
  };
}

/** A run as catalog's draft prepares it, the date projected `technical` unless told otherwise. */
export async function preparedRun(
  desk: RunDesk,
  facts: Partial<RunDateFacts> = {},
): Promise<PreparedRun> {
  const dateId = randomUUID();
  await desk.commands.execute(
    new PrepareRun(
      { messageId: randomUUID(), topic: 'arthome.catalog.date', traceparent: null },
      { dateId, channelId: CHANNEL, occurredAt: new Date(desk.clock.now()) },
    ),
  );
  desk.dates.set(dateId, {
    timing: timingOf(desk.clock.now()),
    publicationState: PublicationState.TECHNICAL,
    ...facts,
  });
  const [run] = await desk.dataSource.query<{ id: string; stream_path: string }[]>(
    'SELECT id, stream_path FROM run WHERE date_id = $1',
    [dateId],
  );
  if (run === undefined) throw new Error('no run prepared');
  return {
    dateId,
    runId: run.id,
    streamPath: run.stream_path,
    key: streamKeyOf(STREAM_KEY_TEST_SECRET, run.id, 1),
  };
}

export interface CallOptions {
  readonly body?: object;
  readonly key?: string | null;
  readonly deadline?: string | null;
  readonly issuer?: string;
}

/** A call as the studio BFF relays it: its token, a deadline, a key and the surface on a write. */
export async function studioCall(
  desk: RunDesk,
  method: 'GET' | 'POST',
  url: string,
  { body, key = randomUUID(), deadline, issuer = InternalTokenIssuer.STUDIO_BFF }: CallOptions = {},
) {
  const token = await mintInternalToken(
    { service: Service.STREAMING, clock: desk.clock, accountId: OPERATOR },
    {
      issuer,
      keyId: issuer === InternalTokenIssuer.STUDIO_BFF ? STUDIO_KEY_ID : DEVELOPMENT_KEY.keyId,
    },
  );
  const due =
    deadline === undefined ? new Date(desk.clock.nowMs() + 60_000).toISOString() : deadline;
  return desk.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(due !== null && { 'x-arthome-deadline': due }),
      ...(method === 'POST' && {
        'x-arthome-actor-surface': Surface.STUDIO_WEB,
        ...(key !== null && { 'idempotency-key': key }),
      }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { payload: body }),
  });
}

export async function versionOf(desk: RunDesk, dateId: string): Promise<number> {
  const [run] = await desk.dataSource.query<{ version: number }[]>(
    'SELECT version FROM run WHERE date_id = $1',
    [dateId],
  );
  if (run === undefined) throw new Error('no run');
  return run.version;
}

/** The date's outbox rows in the order written, all on its key. */
export function outboxOf(
  desk: RunDesk,
  dateId: string,
): Promise<{ type: string; payload: Buffer; aggregatetype: string }[]> {
  // A message id is a UUIDv7, so its order is the order written.
  return desk.dataSource.query(
    `SELECT type, payload, aggregatetype FROM outbox_event WHERE aggregateid = $1 ORDER BY id`,
    [dateId],
  );
}

/** A feed the date's key opens, with a sample the check passes on. */
export async function feedOn(
  desk: RunDesk,
  run: PreparedRun,
  protocol: IngestProtocol = IngestProtocol.RTMPS,
): Promise<void> {
  const decision = await desk.fake.publish(run.streamPath, run.key, { protocol });
  if (!decision.accepted) throw new Error(`feed refused: ${decision.reason}`);
  desk.fake.setFeedSample(run.streamPath, {
    videoCodec: 'h264',
    audioCodec: protocol === IngestProtocol.WHIP ? 'opus' : 'aac',
    ingestUpKbps: 4500,
  });
}
