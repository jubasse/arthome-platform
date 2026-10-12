import { createPublicKey, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  CSRF_COOKIE,
  CSRF_HEADER,
  CSRF_SECRET_COOKIE,
  DEVICE_COOKIE,
  SESSION_COOKIE,
} from '@arthome-platform/bff-storefront/src/session/session-carriers.js';
import { readBetterAuthSecret, readPlaybackSigningKey } from '@arthome-platform/config';
import { InternalTokenVerifier, serveEndpoints } from '@arthome-platform/http-edge';
import { migrateAuthSchema } from '@arthome-platform/identity/src/auth/auth-migrations.js';
import { AuthModule } from '@arthome-platform/identity/src/auth/auth.module.js';
import { CLOCK as IDENTITY_CLOCK } from '@arthome-platform/identity/src/clock.js';
import { EDGE_PROVIDERS as IDENTITY_EDGE_PROVIDERS } from '@arthome-platform/identity/src/edge-providers.js';
import { IDENTITY_SCHEMA } from '@arthome-platform/identity/src/itest/schema.js';
import { deadLetterTopic, retryTopic, runConsumers } from '@arthome-platform/messaging';
import {
  MEDIA_STACK_STOP_MS,
  applyMigrations,
  createDatabase,
  createTopics,
  httpApp,
  registerOutboxConnector,
  startMediaStack,
  startStack,
  type StartedMediaStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { CommandBus } from '@nestjs/cqrs';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { jwtVerify } from 'jose';
import { Kafka, logLevel } from 'kafkajs';
import { Pool } from 'pg';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SessionMode } from '@arthome/contracts/identity';
import {
  ApiErrorCode,
  DisplayState,
  IdentityErrorCode,
  Locale,
  PLAYBACK_TOKEN_LIFETIME_SECONDS,
  PlaybackSessionState,
  RunState,
  Service,
  Surface,
  WatchDenialReason,
} from '@arthome/core';

import { CLOCK } from '../clock.js';
import { applyStreamingMessage } from '../consumed-messages.js';
import {
  DrillClock,
  freePort,
  mediaPlaylist,
  onAir,
  preparedRun,
  type LiveContext,
  type LiveRun,
} from './live-run.js';
import { DevicesConsumerModule } from '../devices/devices-consumer.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { EntitlementConsumerModule } from '../entitlement/entitlement-consumer.module.js';
import { payloadOf } from '../itest/entitlement.js';
import { errorOf, grantSeat, type Playback } from '../itest/playback.js';
import {
  MEDIA_SERVER_TEST_SECRET,
  STREAM_KEY_TEST_SECRET,
  studioTokenVerifier,
  type RunDesk,
} from '../itest/run-desk.js';
import { STREAMING_SCHEMA } from '../itest/schema.js';
import { FakeStreamingProvider } from '../media/fake-streaming-provider.js';
import {
  LIVE_INGEST_PROVIDER,
  PLAYBACK_PROVIDER,
  RECORDING_PROVIDER,
  STREAMING_METRICS_PROVIDER,
} from '../media/media-tokens.js';
import { readMediaMtxEnv } from '../media/mediamtx/mediamtx-env.js';
import { MediaMtxStreamingProvider } from '../media/mediamtx/mediamtx-streaming-provider.js';
import { MEDIA_SERVER_SECRET } from '../media-server/media-server.identity.js';
import { MediaServerModule } from '../media-server/media-server.module.js';
import { PlaybackModule } from '../playback/playback.module.js';
import { ProgressModule } from '../progress/progress.module.js';
import { RunConsumerModule } from '../run/run-consumer.module.js';
import { RunModule } from '../run/run.module.js';
import { STREAM_KEY_SECRET } from '../run/stream-key.js';

/**
 * PE1's drill: a viewer from sign-up to a cut device, on real processes and a real feed. The BFF
 *   signs a viewer up at identity, opens playback at streaming on a MediaMTX feed, and Envoy serves
 *   LL-HLS by the ticket cookie and by `?token=`; revoking the device travels identity's outbox,
 *   Debezium and Kafka to streaming, which cuts the lease, and the edge refuses the old token once
 *   it expires. One clock for the three apps, the machine's: Envoy checks `exp` against real time.
 *
 *   `PE1_HOLD_MINUTES=<n>` keeps the whole stack up for `n` minutes after the renewal, for a
 *   browser run (see `holdMinutes`). Unset, the drill never waits.
 */

const STARTUP_MS = 420_000;
const STEP_MS = 120_000;
const BFF_DEFAULT_PORT = 3003;
const EDGE_CORS_ORIGIN = 'http://localhost:3000';
const PASSWORD = 'a-long-password';
const WEB = { 'x-arthome-surface': Surface.STOREFRONT_WEB };
const REMOTE_ADDRESS = '10.77.0.1';
/** Envoy's clock skew allowance on `exp`, with a margin for the machine. */
const EDGE_SKEW_MS = 5_000;
const LEASE_LAPSE_MS = 95_000;
const LEASE_POLL_MS = 5_000;
const SEGMENT_URL = /\.(mp4|m4s|ts|aac)(\?|$)/;
const DEVICE_TOPIC = 'arthome.identity.device';
const PLAYBACK_COOKIE = 'arthome_playback';

const clock = new DrillClock();

/** The hold's length in minutes, or null: absent, empty, zero or not a number never waits. */
function holdMinutes(): number | null {
  const minutes = Number(process.env.PE1_HOLD_MINUTES);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

interface SetCookie {
  readonly name: string;
  readonly value: string;
}

/** A browser's cookies for the BFF: what its responses set, sent back on its requests. */
class Jar {
  private readonly cookies = new Map<string, string>();

  public absorb(response: { cookies: unknown }): void {
    for (const { name, value } of response.cookies as SetCookie[]) {
      if (value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  public get(name: string): string {
    return this.cookies.get(name) ?? '';
  }

  public header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

interface Ticket {
  readonly sessionId: string;
  readonly resumedExistingSession: boolean;
  readonly edgeRenewalMode: string;
  readonly signature: { readonly queryToken: string | null; readonly cookieSet: boolean };
  readonly manifestUrl: string;
}

interface Opened {
  readonly ticket: Ticket;
  /** The relayed `Set-Cookie` lines for the ticket, and the cookie's value. */
  readonly lines: string[];
  readonly cookie: string;
}

let stack: StartedStack;
let media: StartedMediaStack;
let streamingDb: DataSource;
let identityDb: DataSource;
let streaming: NestFastifyApplication;
let identity: NestFastifyApplication;
let bff: NestFastifyApplication;
let provider: MediaMtxStreamingProvider;
let stopConsumers: () => Promise<void>;
let connectorName: string;
let desk: RunDesk;
let playback: Playback;
let bffUrl = '';
let live: LiveRun;

const email = `pe1-${randomUUID().slice(0, 8)}@example.test`;
const first = new Jar();
const second = new Jar();
let accountId = '';
let firstDeviceId = '';
let profileId = '';
let opened: Opened;
let renewedCookie = '';
let servedSegment = '';

const context = (): LiveContext => ({ clock, dataSource: streamingDb, desk, playback, media });

beforeAll(async () => {
  stack = await startStack({
    postgres: true,
    kafka: true,
    redis: true,
    connect: true,
    startupTimeoutMs: STARTUP_MS,
  });

  // Streaming on MediaMTX, as the real-feed drill boots it, listening for the BFF.
  streamingDb = await applyMigrations(
    await createDatabase(stack.postgres, 'streaming_viewer_playback_drill'),
    STREAMING_SCHEMA,
  );
  const streamingPort = await freePort();
  media = await startMediaStack({
    authorizeUrl: `http://mediamtx:${MEDIA_SERVER_TEST_SECRET}@host.docker.internal:${String(streamingPort)}/v1/media-server/authorize`,
  });
  const env = readMediaMtxEnv(media.providerEnv);
  provider = new MediaMtxStreamingProvider({
    env,
    signingKey: readPlaybackSigningKey({ NODE_ENV: 'test' }),
    clock,
  });
  streaming = await httpApp({
    imports: [
      RunModule,
      RunConsumerModule,
      PlaybackModule,
      ProgressModule,
      EntitlementConsumerModule,
      DevicesConsumerModule,
      MediaServerModule,
    ],
    providers: EDGE_PROVIDERS,
    dataSource: streamingDb,
    overrides: [
      [CLOCK, clock],
      [STREAM_KEY_SECRET, STREAM_KEY_TEST_SECRET],
      [MEDIA_SERVER_SECRET, MEDIA_SERVER_TEST_SECRET],
      [InternalTokenVerifier, studioTokenVerifier(clock)],
      [LIVE_INGEST_PROVIDER, provider],
      [PLAYBACK_PROVIDER, provider],
      [RECORDING_PROVIDER, provider],
      [STREAMING_METRICS_PROVIDER, provider],
    ],
    configure: serveEndpoints,
  });
  await streaming.listen(streamingPort, '0.0.0.0');
  const commands = streaming.get(CommandBus);
  const fake = streaming.get(FakeStreamingProvider);
  desk = {
    stack,
    dataSource: streamingDb,
    app: streaming,
    clock,
    fake,
    commands,
    dates: new Map(),
  };
  playback = {
    stack,
    dataSource: streamingDb,
    app: streaming,
    clock,
    fake,
    apply: (message) => applyStreamingMessage(commands, payloadOf(message)),
    sweep: () => Promise.resolve(0),
  };

  // Streaming's consumer on the device topic, as the consumer process runs it.
  const kafka = new Kafka({
    clientId: 'pe1-drill',
    brokers: [...stack.kafka.brokers],
    logLevel: logLevel.NOTHING,
  });
  await createTopics(kafka, [
    { topic: DEVICE_TOPIC, partitions: 1 },
    { topic: retryTopic(Service.STREAMING), partitions: 1 },
    { topic: deadLetterTopic(Service.STREAMING), partitions: 1 },
  ]);
  const producer = kafka.producer();
  await producer.connect();
  const stopped = await runConsumers({
    kafka,
    producer,
    service: Service.STREAMING,
    sources: [
      {
        topic: DEVICE_TOPIC,
        handler: (payload) => applyStreamingMessage(commands, payload),
      },
    ],
  });
  stopConsumers = async () => {
    await stopped();
    await producer.disconnect();
  };

  // Identity on the stack's Postgres, so Debezium reaches its outbox.
  const identityDatabase = await createDatabase(stack.postgres, 'identity_viewer_playback_drill');
  identityDb = await applyMigrations(identityDatabase, IDENTITY_SCHEMA);
  const pool = new Pool({ connectionString: identityDatabase.url });
  try {
    await migrateAuthSchema(pool, readBetterAuthSecret({ NODE_ENV: 'test' }));
  } finally {
    await pool.end();
  }
  identity = await httpApp({
    imports: [AuthModule],
    providers: IDENTITY_EDGE_PROVIDERS,
    dataSource: identityDb,
    overrides: [[IDENTITY_CLOCK, clock]],
    caller: { service: Service.IDENTITY, clock },
  });
  await identity.listen({ port: 0, host: '127.0.0.1' });
  connectorName = await registerOutboxConnector(stack.connect, Service.IDENTITY, identityDatabase);

  // The BFF, pointed at both.
  const { AppModule } = await import('@arthome-platform/bff-storefront/src/app.module.js');
  const { IDENTITY_URL } =
    await import('@arthome-platform/bff-storefront/src/identity/identity.client.js');
  const { STREAMING_URL } =
    await import('@arthome-platform/bff-storefront/src/playback/streaming.client.js');
  const { PLAYBACK_COOKIE_DOMAIN } =
    await import('@arthome-platform/bff-storefront/src/playback/playback.controller.js');
  const { VIEWER_COUNTRY_HEADER } =
    await import('@arthome-platform/bff-storefront/src/auth/auth.controller.js');
  const { THROTTLER_REDIS, throttlerRedis } =
    await import('@arthome-platform/bff-storefront/src/auth/throttler-storage.js');
  const { CLOCK: BFF_CLOCK } = await import('@arthome-platform/bff-storefront/src/clock.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(IDENTITY_URL)
    .useValue(await identity.getUrl())
    .overrideProvider(STREAMING_URL)
    .useValue(`http://127.0.0.1:${String(streamingPort)}`)
    .overrideProvider(PLAYBACK_COOKIE_DOMAIN)
    .useValue(null)
    .overrideProvider(VIEWER_COUNTRY_HEADER)
    .useValue(null)
    .overrideProvider(BFF_CLOCK)
    .useValue(clock)
    .overrideProvider(THROTTLER_REDIS)
    .useValue(throttlerRedis(stack.redis.url))
    .compile();
  bff = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  serveEndpoints(bff);
  await bff.init();
  await bff.getHttpAdapter().getInstance().ready();
}, STARTUP_MS);

afterAll(async () => {
  const failures: unknown[] = [];
  const settle = async (close: Promise<unknown> | undefined) => {
    try {
      await close;
    } catch (error) {
      failures.push(error);
    }
  };
  try {
    await settle(bff?.close());
    await settle(stopConsumers?.());
    await settle(provider?.beforeApplicationShutdown());
    await settle(streaming?.close());
    await settle(identity?.close());
    if (connectorName !== undefined) {
      await fetch(`${stack.connect.url}/connectors/${connectorName}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    }
    await settle(live?.encoder?.stop());
  } finally {
    await settle(media?.stop());
    await settle(stack?.stop());
  }
  if (failures.length > 0) {
    throw failures[0];
  }
}, MEDIA_STACK_STOP_MS);

function call(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  jar: Jar,
  { payload, headers = {} }: { payload?: object; headers?: Record<string, string> } = {},
) {
  return bff
    .inject({
      method,
      url,
      remoteAddress: REMOTE_ADDRESS,
      headers: {
        ...WEB,
        ...(jar.header() !== '' && { cookie: jar.header() }),
        ...(payload !== undefined && { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(payload !== undefined && { payload }),
    })
    .then((response) => {
      jar.absorb(response);
      return response;
    });
}

/** A write of the signed-in browser: its CSRF token, a fresh idempotency key. */
function write(method: 'POST' | 'DELETE', url: string, jar: Jar, payload?: object) {
  return call(method, url, jar, {
    ...(payload !== undefined && { payload }),
    headers: { [CSRF_HEADER]: jar.get(CSRF_COOKIE), 'idempotency-key': randomUUID() },
  });
}

function setCookieLines(response: {
  headers: Record<string, string | string[] | number | undefined>;
}): string[] {
  const lines = response.headers['set-cookie'];
  if (lines === undefined) return [];
  return Array.isArray(lines) ? lines : [String(lines)];
}

function viewerContextOf(response: { json<T>(): T }) {
  return response.json<{
    data: { deviceId: string; currentProfileId: string; profiles: { id: string }[] };
  }>().data;
}

async function openOnFirstDevice(): Promise<Opened> {
  const response = await attemptOpen();
  expect(response.statusCode, response.body).toBe(200);
  const ticket = response.json<{ data: Ticket }>().data;
  const lines = setCookieLines(response).filter((line) => line.startsWith(`${PLAYBACK_COOKIE}=`));
  return { ticket, lines, cookie: cookieValueOf(lines) };
}

function cookieValueOf(lines: string[]): string {
  return /^arthome_playback=([^;]*)/.exec(lines[0] ?? '')?.[1] ?? '';
}

function viaCookie(url: string, cookie: string) {
  return fetch(url, {
    headers: { cookie: `${PLAYBACK_COOKIE}=${cookie}`, origin: EDGE_CORS_ORIGIN },
  });
}

/** Multivariant, media playlist, a part and a segment, by the cookie or by the query token. */
async function edgeServes(manifestUrl: string, by: { cookie: string } | { token: string }) {
  const get = async (url: string) => {
    if ('cookie' in by) return viaCookie(url, by.cookie);
    return fetch(`${url}?token=${by.token}`);
  };
  const multivariant = await get(manifestUrl);
  const multivariantBody = await multivariant.text();
  const mediaUri = multivariantBody.split('\n').find((line) => line.endsWith('.m3u8'));
  expect(multivariant.status, multivariantBody).toBe(200);
  const mediaUrl = new URL(mediaUri ?? '', manifestUrl).href;
  const mediaAnswer = await get(mediaUrl);
  const mediaBody = await mediaAnswer.text();
  expect(mediaAnswer.status).toBe(200);
  const part = /#EXT-X-PART:[^\n]*URI="([^"]+)"/.exec(mediaBody)?.[1];
  const segment = mediaBody
    .split('\n')
    .filter((line) => line !== '' && !line.startsWith('#'))
    .at(-1);
  expect(part, 'the playlist lists a part').toBeDefined();
  expect(segment, 'the playlist lists a segment').toBeDefined();
  const partAnswer = await get(new URL(part ?? '', mediaUrl).href);
  const segmentAnswer = await get(new URL(segment ?? '', mediaUrl).href);
  await partAnswer.arrayBuffer();
  await segmentAnswer.arrayBuffer();
  return {
    answers: [multivariant, mediaAnswer, partAnswer, segmentAnswer],
    segmentUrl: new URL(segment ?? '', mediaUrl).href,
  };
}

async function leaseOf(sessionId: string) {
  const [row] = await streamingDb.query<{ state: string; revoke_reason: string | null }[]>(
    'SELECT state, revoke_reason FROM playback_session WHERE id = $1',
    [sessionId],
  );
  return row;
}

/** The storefront's `BFF_URL` default when its port is free, else any free one. */
async function listenBff(): Promise<string> {
  const free = await new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(BFF_DEFAULT_PORT, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
  await bff.listen({ port: free ? BFF_DEFAULT_PORT : 0, host: '127.0.0.1' });
  return bff.getUrl();
}

async function hold(minutes: number, viewerEmail: string, dateId: string): Promise<void> {
  const edgeUrl = media.playbackEdgeUrl.replace('127.0.0.1', 'localhost');
  const endsAt = new Date(Date.now() + minutes * 60_000);
  const lines = [
    '',
    '=== PE1 hold: the stack stays up ===',
    `BFF           ${bffUrl}`,
    `Edge          ${edgeUrl} (storefront origin ${EDGE_CORS_ORIGIN})`,
    `Date id       ${dateId}`,
    `Viewer        ${viewerEmail} / ${PASSWORD} (a drill account, a seat is granted)`,
    `Hold ends     ${endsAt.toISOString()}`,
    'Sign in at the storefront, watch, then LEAVE THE PAGE (this releases the browser lease)',
    'before the hold ends: the drill then reopens its own playback and goes on to the revoke.',
    "Hold mode exposes streaming's test-secret API on all of this machine's network interfaces.",
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  await sleep(minutes * 60_000);
}

describe('a viewer from sign-up to a cut device', () => {
  it(
    'signs up with a default profile and a registered browser device',
    async () => {
      const signedUp = await call('POST', '/v1/auth/sign-up', first, {
        payload: {
          email,
          password: PASSWORD,
          mode: SessionMode.COOKIE,
          acceptedTermsVersion: 3,
          locale: Locale.FR,
        },
        headers: { 'idempotency-key': randomUUID() },
      });
      expect(signedUp.statusCode, signedUp.body).toBe(201);
      for (const name of [SESSION_COOKIE, CSRF_COOKIE, CSRF_SECRET_COOKIE, DEVICE_COOKIE]) {
        expect(first.get(name), name).not.toBe('');
      }

      const viewer = viewerContextOf(await call('GET', '/v1/viewer-context', first));
      firstDeviceId = viewer.deviceId;
      profileId = viewer.currentProfileId;
      expect(firstDeviceId).not.toBe('');
      expect(viewer.profiles.map(({ id }) => id)).toEqual([profileId]);

      const profiles = await identityDb.query<{ id: string; account_id: string }[]>(
        'SELECT id, account_id FROM profile WHERE is_default',
      );
      expect(profiles).toHaveLength(1);
      expect(profiles[0]?.id).toBe(profileId);
      accountId = profiles[0]?.account_id ?? '';
      const devices = await identityDb.query<{ id: string }[]>(
        'SELECT d.id FROM device d JOIN device_session s ON s.device_id = d.id WHERE s.account_id = $1',
        [accountId],
      );
      expect(devices.map(({ id }) => id)).toEqual([firstDeviceId]);
    },
    STEP_MS,
  );

  it(
    'has a date on air with a seat for the account',
    async () => {
      live = await preparedRun(context());
      await onAir(context(), live, 'whip');
      await grantSeat(playback, accountId, live.dateId);
      expect((await runRowState()) satisfies RunState).toBe(RunState.ON_AIR);
    },
    STEP_MS,
  );

  it(
    'opens playback through the BFF: a ticket cookie on the date, host-only, for the profile and device',
    async () => {
      opened = await openOnFirstDevice();
      const { ticket, lines, cookie } = opened;
      expect(ticket.edgeRenewalMode).toBe('signed_cookie');
      expect(ticket.signature).toEqual({ queryToken: null, cookieSet: true });
      expect(ticket.manifestUrl).toContain(`/watch/${live.dateId}/`);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`Path=/watch/${live.dateId}/`);
      expect(lines[0]?.toLowerCase()).not.toContain('domain=');

      const key = createPublicKey({
        key: readPlaybackSigningKey({ NODE_ENV: 'test' }).privateJwk,
        format: 'jwk',
      });
      const { payload } = await jwtVerify(cookie, key, { currentDate: new Date(clock.now()) });
      expect(payload).toMatchObject({ sub: profileId, did: firstDeviceId, dat: live.dateId });
    },
    STEP_MS,
  );

  it(
    'serves LL-HLS at the edge by the ticket cookie, with the storefront origin allowed',
    async () => {
      // The edge path is configured and its first playlist cut after the first ticket.
      const { answers } = await vi.waitFor(
        () => edgeServes(opened.ticket.manifestUrl, { cookie: opened.cookie }),
        { timeout: 60_000, interval: 1_000 },
      );
      for (const answer of answers) {
        expect(answer.status).toBe(200);
        expect(answer.headers.get('access-control-allow-origin')).toBe(EDGE_CORS_ORIGIN);
        expect(answer.headers.get('access-control-allow-credentials')).toBe('true');
      }
    },
    STEP_MS,
  );

  it(
    'serves the same four requests by ?token= with no cookie, as native players do',
    async () => {
      const { answers } = await edgeServes(opened.ticket.manifestUrl, { token: opened.cookie });
      expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200, 200]);
    },
    STEP_MS,
  );

  it(
    'renews through the BFF: a new cookie on the same path, served at the edge',
    async () => {
      const renewed = await write(
        'POST',
        `/v1/playback/sessions/${opened.ticket.sessionId}/renew`,
        first,
      );
      expect(renewed.statusCode, renewed.body).toBe(200);
      const lines = setCookieLines(renewed).filter((line) =>
        line.startsWith(`${PLAYBACK_COOKIE}=`),
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`Path=/watch/${live.dateId}/`);
      renewedCookie = cookieValueOf(lines);
      expect(renewedCookie).not.toBe('');
      expect(expiryMsOf(renewedCookie)).toBeGreaterThanOrEqual(expiryMsOf(opened.cookie));

      const read = await mediaPlaylist(opened.ticket.manifestUrl, renewedCookie);
      expect(read.status).toBe(200);
      expect(read.segment, 'the playlist lists a segment').toMatch(SEGMENT_URL);
      servedSegment = read.segment;
      expect((await viaCookie(servedSegment, renewedCookie)).status).toBe(200);
    },
    STEP_MS,
  );

  it.skipIf(holdMinutes() === null)(
    'holds the stack for a browser, the lease released before and reopened after',
    async () => {
      const minutes = holdMinutes() ?? 0;
      const released = await write(
        'POST',
        `/v1/playback/sessions/${opened.ticket.sessionId}/release`,
        first,
      );
      expect(released.statusCode, released.body).toBe(204);
      expect((await leaseOf(opened.ticket.sessionId))?.state).toBe(PlaybackSessionState.RELEASED);

      bffUrl = await listenBff();
      await hold(minutes, email, live.dateId);

      let reopened = await attemptOpen();
      if (reopened.statusCode !== 200) {
        expect(errorOf(reopened).code).toBe(WatchDenialReason.CONCURRENT_LIMIT_REACHED);
        const deadline = Date.now() + LEASE_LAPSE_MS;
        while (reopened.statusCode !== 200 && Date.now() < deadline) {
          await sleep(LEASE_POLL_MS);
          reopened = await attemptOpen();
        }
      }
      expect(reopened.statusCode, reopened.body).toBe(200);
      const ticket = reopened.json<{ data: Ticket }>().data;
      expect(ticket.sessionId).not.toBe(opened.ticket.sessionId);
      expect(ticket.resumedExistingSession).toBe(false);
      const lines = setCookieLines(reopened).filter((line) =>
        line.startsWith(`${PLAYBACK_COOKIE}=`),
      );
      opened = { ticket, lines, cookie: cookieValueOf(lines) };
      const renewed = await write('POST', `/v1/playback/sessions/${ticket.sessionId}/renew`, first);
      expect(renewed.statusCode, renewed.body).toBe(200);
      renewedCookie = cookieValueOf(
        setCookieLines(renewed).filter((line) => line.startsWith(`${PLAYBACK_COOKIE}=`)),
      );
    },
    minutesToStep(),
  );

  it(
    "revokes the first device from a second sign-in, and the lease is cut by identity's event",
    async () => {
      const signedIn = await call('POST', '/v1/auth/sign-in', second, {
        payload: { email, password: PASSWORD, mode: SessionMode.COOKIE },
      });
      expect(signedIn.statusCode, signedIn.body).toBe(200);
      const otherDevice = viewerContextOf(await call('GET', '/v1/viewer-context', second));
      expect(otherDevice.deviceId).not.toBe(firstDeviceId);

      const revoked = await write('DELETE', `/v1/me/devices/${firstDeviceId}`, second);
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect(revoked.json()).toMatchObject({
        data: { playbackCutWithinSec: PLAYBACK_TOKEN_LIFETIME_SECONDS },
      });
      const cleared = setCookieLines(revoked).filter((line) =>
        [SESSION_COOKIE, DEVICE_COOKIE].some((name) => line.startsWith(`${name}=`)),
      );
      expect(cleared).toEqual([]);

      await vi.waitFor(
        async () => {
          expect(await leaseOf(opened.ticket.sessionId)).toEqual({
            state: PlaybackSessionState.REVOKED,
            revoke_reason: IdentityErrorCode.SIGNED_OUT_ELSEWHERE,
          });
        },
        { timeout: 30_000, interval: 500 },
      );
    },
    STEP_MS,
  );

  it(
    "refuses the revoked device's renewal, then the edge refuses its token once it expires",
    async () => {
      const refused = await write(
        'POST',
        `/v1/playback/sessions/${opened.ticket.sessionId}/renew`,
        first,
      );
      expect(refused.statusCode).toBe(401);
      expect(errorOf(refused).code).toBe(ApiErrorCode.UNAUTHENTICATED);

      const expiresAtMs = expiryMsOf(renewedCookie);
      await sleep(Math.max(0, expiresAtMs + EDGE_SKEW_MS - Date.now()) + 1_000);
      const cut = await viaCookie(servedSegment, renewedCookie);
      expect(cut.status).toBe(401);
      expect(cut.headers.get('access-control-allow-origin')).toBe(EDGE_CORS_ORIGIN);
      expect(cut.headers.get('access-control-allow-credentials')).toBe('true');
    },
    STEP_MS + (PLAYBACK_TOKEN_LIFETIME_SECONDS + 20) * 1_000,
  );
});

function minutesToStep(): number {
  return STEP_MS + ((holdMinutes() ?? 0) * 60 + (2 * LEASE_LAPSE_MS) / 1_000) * 1_000;
}

async function attemptOpen() {
  return write('POST', `/v1/playback/${live.dateId}/open`, first, {
    deviceId: firstDeviceId,
    profileId,
    kind: DisplayState.LIVE,
    capabilities: { maxHeightPx: 1080 },
  });
}

async function runRowState(): Promise<RunState> {
  const [row] = await streamingDb.query<{ state: RunState }[]>(
    'SELECT state FROM run WHERE id = $1',
    [live.runId],
  );
  return row?.state ?? RunState.IDLE;
}

function expiryMsOf(token: string): number {
  const [, body = ''] = token.split('.');
  const { exp } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { exp: number };
  return exp * 1_000;
}
