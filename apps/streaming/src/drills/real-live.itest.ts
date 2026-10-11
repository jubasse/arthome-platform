import { randomUUID } from 'node:crypto';

import { readPlaybackSigningKey } from '@arthome-platform/config';
import {
  DateOutcome as WireDateOutcome,
  DateOutcomeDeclaredSchema,
  DateScheduledSchema,
  PublicationState as WirePublicationState,
  PublicationStateChangedSchema,
  ReplayPolicy as WireReplayPolicy,
  RightsScope as WireRightsScope,
} from '@arthome-platform/events';
import { InternalTokenVerifier, serveEndpoints } from '@arthome-platform/http-edge';
import {
  applyMigrations,
  createDatabase,
  httpApp,
  MEDIA_STACK_STOP_MS,
  startMediaStack,
  startStack,
  type EncoderProtocol,
  type StartedEncoder,
  type StartedMediaStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { CommandBus } from '@nestjs/cqrs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { EdgeRenewalMode, QualityCap } from '@arthome/contracts/streaming';
import {
  FixedClock,
  HOLD_SCREEN_AUTO_AFTER_SECONDS_DEFAULT,
  IncidentCause,
  PLAYBACK_TOKEN_LIFETIME_SECONDS,
  PUBLISHER_GRACE_SECONDS,
  ReplayAssetState,
  RunState,
  SystemClock,
  fromEpochMs,
  toEpochMs,
  WatchScope,
  type Instant,
} from '@arthome/core';

import { CLOCK } from '../clock.js';
import { applyStreamingMessage } from '../consumed-messages.js';
import { DevicesConsumerModule } from '../devices/devices-consumer.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { EntitlementConsumerModule } from '../entitlement/entitlement-consumer.module.js';
import { CATALOG_DATE_TOPIC, payloadOf, wireMessage } from '../itest/entitlement.js';
import {
  cancelSeat,
  grantSeat,
  newViewer,
  openCall,
  renewCall,
  ticketOf,
  type Playback,
} from '../itest/playback.js';
import {
  STREAM_KEY_TEST_SECRET,
  outboxOf,
  studioCall,
  studioTokenVerifier,
  type RunDesk,
} from '../itest/run-desk.js';
import { STREAMING_SCHEMA } from '../itest/schema.js';
import { FakeStreamingProvider } from '../media/fake-streaming-provider.js';
import type { PlaybackGrant } from '../media/media-ports.js';
import {
  LIVE_INGEST_PROVIDER,
  PLAYBACK_PROVIDER,
  RECORDING_PROVIDER,
  STREAMING_METRICS_PROVIDER,
} from '../media/media-tokens.js';
import {
  startMediaServerStandIn,
  type MediaServerStandIn,
} from '../media/mediamtx/media-server-stand-in.js';
import { readMediaMtxEnv } from '../media/mediamtx/mediamtx-env.js';
import { MediaMtxHttp } from '../media/mediamtx/mediamtx-http.js';
import { MediaMtxStreamingProvider } from '../media/mediamtx/mediamtx-streaming-provider.js';
import { PlaybackModule } from '../playback/playback.module.js';
import { ProgressModule } from '../progress/progress.module.js';
import { ReplayAssetSweeperModule } from '../replay-asset/replay-asset-sweeper.module.js';
import { RunIngestAuthorizer } from '../run/ingest-authorizer.js';
import { PrepareRun } from '../run/prepare-run.command.js';
import { RunConsumerModule } from '../run/run-consumer.module.js';
import { SweepRunPresence } from '../run/run-passes.js';
import { RunSweeperModule } from '../run/run-sweeper.module.js';
import { RunModule } from '../run/run.module.js';
import { STREAM_KEY_SECRET, streamKeyOf } from '../run/stream-key.js';

/**
 * MX2's drill: a real feed through the whole chain, on the pinned images. An encoder publishes
 *   with the run's key, the technical check reads a real sample (D-114), PS3 opens playback and
 *   Envoy serves AAC LL-HLS on its token, a cut keeps the manifest, a lost feed's hold screen lifts
 *   on its return (D-124), a refused renewal stops playback at `exp` (adr §3.2, §3.3), an SRT feed
 *   gets no worker, a failed worker raises its incident, and a replay is recorded at ingest, ready,
 *   then deleted. The clock is the machine's, moved forward only to cross the hold screen's delay,
 *   because Envoy checks `exp` against real time.
 */

const STARTUP_MS = 300_000;
const STEP_MS = 120_000;
const CHANNEL = '01a0f0cc-0000-7000-8000-0000000000d7';
const OCCURRED_AT = timestampFromDate(new Date('2026-10-01T10:00:00.000Z'));

/** The machine's time, which a step may move forward: `FixedClock` is what the harness types. */
class DrillClock extends FixedClock {
  private readonly system = new SystemClock();
  private offsetMs = 0;

  public constructor() {
    super(new SystemClock().nowMs());
  }

  public override nowMs(): number {
    return this.system.nowMs() + this.offsetMs;
  }

  public override now(): Instant {
    return fromEpochMs(this.nowMs());
  }

  public override advance(millis: number): Instant {
    this.offsetMs += millis;
    return this.now();
  }
}

interface LiveRun {
  readonly dateId: string;
  readonly runId: string;
  readonly streamPath: string;
  readonly key: string;
  encoder: StartedEncoder | null;
}

let stack: StartedStack;
let media: StartedMediaStack;
let standIn: MediaServerStandIn;
let dataSource: DataSource;
let app: NestFastifyApplication;
let provider: MediaMtxStreamingProvider;
let originApi: MediaMtxHttp;
let edgeApi: MediaMtxHttp;
const clock = new DrillClock();
let desk: RunDesk;
let playback: Playback;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  dataSource = await applyMigrations(
    await createDatabase(stack.postgres, 'streaming_real_live_drill'),
    STREAMING_SCHEMA,
  );
  standIn = await startMediaServerStandIn({
    authorize: (attempt) => app.get(RunIngestAuthorizer).authorize(attempt),
  });
  media = await startMediaStack({ authorizeUrl: standIn.authorizeUrl });
  const env = readMediaMtxEnv(media.providerEnv);
  originApi = new MediaMtxHttp('the origin', env.originApiUrl);
  edgeApi = new MediaMtxHttp('the edge', env.edgeApiUrl);
  provider = new MediaMtxStreamingProvider({
    env,
    signingKey: readPlaybackSigningKey({ NODE_ENV: 'test' }),
    clock,
  });
  app = await httpApp({
    imports: [
      RunModule,
      RunConsumerModule,
      RunSweeperModule,
      PlaybackModule,
      ProgressModule,
      EntitlementConsumerModule,
      DevicesConsumerModule,
      ReplayAssetSweeperModule,
    ],
    providers: EDGE_PROVIDERS,
    dataSource,
    overrides: [
      [CLOCK, clock],
      [STREAM_KEY_SECRET, STREAM_KEY_TEST_SECRET],
      [InternalTokenVerifier, studioTokenVerifier(clock)],
      [LIVE_INGEST_PROVIDER, provider],
      [PLAYBACK_PROVIDER, provider],
      [RECORDING_PROVIDER, provider],
      [STREAMING_METRICS_PROVIDER, provider],
    ],
    configure: serveEndpoints,
  });
  const commands = app.get(CommandBus);
  // The suites' harness types: the fake is bound beside the overridden ports and stays unused.
  const fake = app.get(FakeStreamingProvider);
  desk = { stack, dataSource, app, clock, fake, commands, dates: new Map() };
  playback = {
    stack,
    dataSource,
    app,
    clock,
    fake,
    apply: (message) => applyStreamingMessage(commands, payloadOf(message)),
    sweep: () => Promise.resolve(0),
  };
}, STARTUP_MS);

afterAll(async () => {
  await provider.beforeApplicationShutdown();
  await app.close();
  await media.stop();
  await standIn.close();
  await stack.stop();
}, MEDIA_STACK_STOP_MS);

async function scheduledDate(replayPolicy: WireReplayPolicy): Promise<string> {
  const dateId = randomUUID();
  for (const message of [
    wireMessage(CATALOG_DATE_TOPIC, 'catalog.date.scheduled.v1', DateScheduledSchema, dateId, {
      dateId,
      channelId: CHANNEL,
      startsAt: timestampFromDate(new Date(clock.now())),
      runtimeMin: 90,
      replayPolicy,
      replayWindowHours: replayPolicy === WireReplayPolicy.NONE ? 0 : 48,
      rights: { scope: WireRightsScope.WORLDWIDE },
      occurredAt: OCCURRED_AT,
    }),
    publication(dateId, WirePublicationState.TECHNICAL, 1n),
  ]) {
    await playback.apply(message);
  }
  return dateId;
}

function publication(dateId: string, toState: WirePublicationState, version: bigint) {
  return wireMessage(
    CATALOG_DATE_TOPIC,
    'catalog.publication.state_changed.v1',
    PublicationStateChangedSchema,
    dateId,
    { dateId, channelId: CHANNEL, toState, version, occurredAt: OCCURRED_AT },
  );
}

async function preparedRun(replayPolicy = WireReplayPolicy.NONE): Promise<LiveRun> {
  const dateId = await scheduledDate(replayPolicy);
  await desk.commands.execute(
    new PrepareRun(
      { messageId: randomUUID(), topic: CATALOG_DATE_TOPIC, traceparent: null },
      { dateId, channelId: CHANNEL, occurredAt: new Date(clock.now()) },
    ),
  );
  const [run] = await dataSource.query<{ id: string; stream_path: string }[]>(
    'SELECT id, stream_path FROM run WHERE date_id = $1',
    [dateId],
  );
  if (run === undefined) throw new Error('no run prepared');
  return {
    dateId,
    runId: run.id,
    streamPath: run.stream_path,
    key: streamKeyOf(STREAM_KEY_TEST_SECRET, run.id, 1),
    encoder: null,
  };
}

async function runRow(run: LiveRun) {
  const [row] = await dataSource.query<
    { state: RunState; publisher_online_since: Date | null; version: number }[]
  >('SELECT state, publisher_online_since, version FROM run WHERE id = $1', [run.runId]);
  return row;
}

async function publish(run: LiveRun, protocol: EncoderProtocol): Promise<void> {
  // eslint-disable-next-line no-param-reassign -- the drill's run carries its encoder.
  run.encoder = await media.startEncoder({ protocol, streamPath: run.streamPath, key: run.key });
  await vi.waitFor(async () => expect((await runRow(run))?.publisher_online_since).not.toBeNull(), {
    timeout: 45_000,
    interval: 250,
  });
}

async function onAir(run: LiveRun, protocol: EncoderProtocol): Promise<unknown> {
  await publish(run, protocol);
  const check = await vi.waitFor(
    async () => {
      const answer = await studioCall(desk, 'POST', `/v1/dates/${run.dateId}/run/technical-check`);
      const body = answer.json<unknown>();
      expect(body).toMatchObject({ data: { passed: true } });
      return body;
    },
    { timeout: 20_000, interval: 1_000 },
  );
  const onAirAnswer = await studioCall(desk, 'POST', `/v1/dates/${run.dateId}/run/go-on-air`, {
    body: { expectedVersion: 2 },
  });
  expect(onAirAnswer.statusCode, onAirAnswer.body).toBe(200);
  await playback.apply(publication(run.dateId, WirePublicationState.LIVE, 2n));
  return check;
}

async function edgeGet(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
}

/** The date's media playlist through Envoy, with its sequence and its newest segment. */
async function mediaPlaylist(manifestUrl: string, token: string) {
  const multivariant = await edgeGet(`${manifestUrl}?token=${token}`);
  const mediaUri = multivariant.body.split('\n').find((line) => line.endsWith('.m3u8'));
  if (multivariant.status !== 200 || mediaUri === undefined) {
    return {
      status: multivariant.status,
      multivariant: multivariant.body,
      body: '',
      sequence: -1,
      segment: '',
    };
  }
  const media = await edgeGet(`${new URL(mediaUri, manifestUrl).href}?token=${token}`);
  const sequence = Number(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(media.body)?.[1] ?? -1);
  const segment =
    media.body
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'))
      .at(-1) ?? '';
  return {
    status: media.status,
    multivariant: multivariant.body,
    body: media.body,
    sequence,
    segment: new URL(segment, manifestUrl).href,
  };
}

let whip: LiveRun;
let opened: { manifestUrl: string; token: string; expiresAt: Instant; sessionId: string };

describe('a real live through MediaMTX and Envoy', () => {
  it(
    'publishes with the run key, passes the technical check on a real sample, goes on air',
    async () => {
      whip = await preparedRun();
      const check = await onAir(whip, 'whip');

      expect(check).toMatchObject({ data: { passed: true, failures: [] } });
      expect((await runRow(whip))?.state).toBe(RunState.ON_AIR);
    },
    STEP_MS,
  );

  it(
    'opens playback through PS3 and Envoy serves AAC LL-HLS on its token',
    async () => {
      const viewer = newViewer();
      const seatId = await grantSeat(playback, viewer.accountId, whip.dateId);
      const answer = await openCall(playback, viewer, whip.dateId);
      expect(answer.statusCode, answer.body).toBe(200);
      const ticket = ticketOf(answer);
      const { data } = answer.json<{
        data: { expiresAt: Instant; signature: { queryToken: string } };
      }>();
      opened = {
        manifestUrl: ticket.manifestUrl,
        token: data.signature.queryToken,
        expiresAt: data.expiresAt,
        sessionId: ticket.sessionId,
      };

      const playlist = await vi.waitFor(
        async () => {
          const read = await mediaPlaylist(opened.manifestUrl, opened.token);
          expect(read.body).toContain('#EXT-X-PART:');
          return read;
        },
        { timeout: 30_000, interval: 1_000 },
      );
      expect(playlist.multivariant).toMatch(/CODECS="avc1\.[0-9a-f]+,mp4a\.40\.2"/);
      expect((await edgeGet(`${playlist.segment}?token=${opened.token}`)).status).toBe(200);

      // Revocation (adr §3.3): the seat lost, PS3 refuses the renewal; Envoy serves the token in
      // hand until its `exp`, then refuses every request.
      await cancelSeat(playback, seatId, viewer.accountId, whip.dateId);
      const renewed = await renewCall(playback, viewer, opened.sessionId);
      expect(renewed.statusCode).not.toBe(200);
      expect((await edgeGet(`${playlist.segment}?token=${opened.token}`)).status).toBe(200);
      const pastExpMs = toEpochMs(opened.expiresAt) + 6_000 - new SystemClock().nowMs();
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, pastExpMs)));
      const after = await mediaPlaylist(opened.manifestUrl, opened.token);
      expect(after.status).toBe(401);
    },
    // The token's lifetime and Envoy's clock skew are waited in real time.
    STEP_MS + (PLAYBACK_TOKEN_LIFETIME_SECONDS + 10) * 1_000,
  );

  it(
    'keeps the media sequence through a cut: the publisher kicked, back by its own retry',
    async () => {
      const token = (await provider.sign(grantFor(whip))).queryToken ?? '';
      const before = await mediaPlaylist(opened.manifestUrl, token);
      const cutAtMs = new SystemClock().nowMs();
      await provider.disconnect(whip.streamPath);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const during = await mediaPlaylist(opened.manifestUrl, token);
      await vi.waitFor(
        async () => expect((await runRow(whip))?.publisher_online_since).not.toBeNull(),
        { timeout: 30_000, interval: 250 },
      );
      // MediaMTX's WHIP client comes back after about 5 s: within the worker's 12 s.
      expect(new SystemClock().nowMs() - cutAtMs).toBeLessThan(12_000);
      const after = await vi.waitFor(
        async () => {
          const read = await mediaPlaylist(opened.manifestUrl, token);
          expect(read.sequence).toBeGreaterThan(before.sequence);
          return read;
        },
        { timeout: 30_000, interval: 1_000 },
      );

      expect(during.status).toBe(200);
      expect(during.sequence).toBeGreaterThanOrEqual(before.sequence);
      expect(after.sequence).toBeGreaterThanOrEqual(during.sequence);
    },
    STEP_MS,
  );

  it(
    'routes an SRT feed to the edge without an audio worker',
    async () => {
      const srt = await preparedRun();
      await publish(srt, 'srt');
      await provider.sign(grantFor(srt));

      const configured = await vi.waitFor(
        async () => {
          const read = await edgeApi.json<{ source: string; runOnInit: string }>({
            operation: 'drill read',
            path: `/v3/config/paths/get/watch/${srt.dateId}`,
          });
          expect(read).not.toBeNull();
          return read;
        },
        { timeout: 15_000, interval: 500 },
      );
      expect(configured?.source).toBe(`rtsp://mediamtx-origin:8554/live/${srt.streamPath}`);
      expect(configured?.runOnInit).toBe('');
      await srt.encoder?.stop();
    },
    STEP_MS,
  );

  it(
    'records a date with a replay mode at ingest, ready at its end, then deleted; none without',
    async () => {
      const replayed = await preparedRun(WireReplayPolicy.INCLUDED);
      await onAir(replayed, 'srt');
      const recording = await vi.waitFor(
        async () => {
          const read = await originApi.json<{ record: boolean }>({
            operation: 'drill read',
            path: `/v3/config/paths/get/live/${replayed.streamPath}`,
          });
          expect(read?.record).toBe(true);
          return read;
        },
        { timeout: 15_000, interval: 500 },
      );
      expect(recording?.record).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 8_000));

      const ended = await studioCall(desk, 'POST', `/v1/dates/${replayed.dateId}/run/end`, {
        body: { expectedVersion: (await runRow(replayed))?.version ?? 0 },
      });
      expect(ended.statusCode, ended.body).toBe(200);
      await vi.waitFor(
        async () => {
          const [asset] = await dataSource.query<{ state: ReplayAssetState }[]>(
            'SELECT state FROM replay_asset WHERE date_id = $1',
            [replayed.dateId],
          );
          expect(asset?.state).toBe(ReplayAssetState.READY);
        },
        { timeout: 90_000, interval: 1_000 },
      );

      await playback.apply(
        wireMessage(
          CATALOG_DATE_TOPIC,
          'catalog.date.outcome_declared.v1',
          DateOutcomeDeclaredSchema,
          replayed.dateId,
          {
            dateId: replayed.dateId,
            channelId: CHANNEL,
            outcome: WireDateOutcome.INTERRUPTED,
            declaredAt: timestampFromDate(new Date(clock.now())),
          },
        ),
      );
      await vi.waitFor(
        async () => {
          const segments = await originApi.json<{ segments: unknown[] }>({
            operation: 'drill read',
            path: `/v3/recordings/get/live/${replayed.streamPath}`,
          });
          expect(segments?.segments ?? []).toEqual([]);
        },
        { timeout: 60_000, interval: 1_000 },
      );
      const volume = await originApi.json<{ items: { name: string }[] }>({
        operation: 'drill read',
        path: '/v3/recordings/list',
      });
      expect(volume?.items.map(({ name }) => name)).not.toContain(`live/${whip.streamPath}`);
      await replayed.encoder?.stop();
    },
    STEP_MS + 60_000,
  );

  it(
    'raises the hold screen on a lost feed and lifts it when the feed returns (D-124)',
    async () => {
      await whip.encoder?.stop();
      await vi.waitFor(
        async () => expect((await runRow(whip))?.publisher_online_since).toBeNull(),
        { timeout: 30_000, interval: 250 },
      );
      clock.advance((PUBLISHER_GRACE_SECONDS + HOLD_SCREEN_AUTO_AFTER_SECONDS_DEFAULT + 1) * 1_000);
      await desk.commands.execute(new SweepRunPresence());
      await desk.commands.execute(new SweepRunPresence());
      expect((await runRow(whip))?.state).toBe(RunState.INTERRUPTED);

      await publish(whip, 'whip');

      await vi.waitFor(async () => expect((await runRow(whip))?.state).toBe(RunState.ON_AIR), {
        timeout: 30_000,
        interval: 500,
      });
    },
    STEP_MS,
  );

  it(
    'raises compatibility_worker_failed when the audio worker fails for good',
    async () => {
      await provider.sign(grantFor(whip));
      const written = (await outboxOf(desk, whip.dateId)).length;
      await media.failAudioWorkers();

      await vi.waitFor(
        async () => {
          const [incident] = await dataSource.query<{ cause: string }[]>(
            'SELECT cause FROM incident WHERE run_id = $1 AND resolved_at IS NULL',
            [whip.runId],
          );
          expect(incident?.cause).toBe(IncidentCause.COMPATIBILITY_WORKER_FAILED);
        },
        { timeout: 60_000, interval: 1_000 },
      );
      expect((await outboxOf(desk, whip.dateId)).length).toBeGreaterThan(written);
    },
    STEP_MS,
  );
});

function grantFor(run: LiveRun): PlaybackGrant {
  return {
    dateId: run.dateId,
    streamPath: run.streamPath,
    sessionScope: randomUUID(),
    claims: {
      sub: randomUUID(),
      did: run.dateId,
      dat: randomUUID(),
      sid: randomUUID(),
      qmax: QualityCap.FHD,
      scope: WatchScope.FULL,
      jti: randomUUID(),
    },
    expiresAt: fromEpochMs(new SystemClock().nowMs() + 120_000),
    mechanism: EdgeRenewalMode.QUERY_TOKEN,
  };
}
