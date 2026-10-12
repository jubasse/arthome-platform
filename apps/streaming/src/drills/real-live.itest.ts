import { randomUUID } from 'node:crypto';

import { readPlaybackSigningKey } from '@arthome-platform/config';
import {
  DateOutcome as WireDateOutcome,
  DateOutcomeDeclaredSchema,
  ReplayPolicy as WireReplayPolicy,
} from '@arthome-platform/events';
import { InternalTokenVerifier, serveEndpoints } from '@arthome-platform/http-edge';
import {
  applyMigrations,
  createDatabase,
  httpApp,
  MEDIA_STACK_STOP_MS,
  startMediaStack,
  startStack,
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
  HOLD_SCREEN_AUTO_AFTER_SECONDS_DEFAULT,
  IncidentCause,
  PLAYBACK_TOKEN_LIFETIME_SECONDS,
  PUBLISHER_GRACE_SECONDS,
  ReplayAssetState,
  RunState,
  SystemClock,
  fromEpochMs,
  toEpochMs,
  WatchDenialReason,
  WatchScope,
  type Instant,
} from '@arthome/core';

import { CLOCK } from '../clock.js';
import { applyStreamingMessage } from '../consumed-messages.js';
import { DevicesConsumerModule } from '../devices/devices-consumer.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import {
  CHANNEL,
  DrillClock,
  edgeGet,
  freePort,
  mediaPlaylist,
  onAir,
  preparedRun,
  publish,
  runRow,
  type LiveContext,
  type LiveRun,
} from './live-run.js';
import { EntitlementConsumerModule } from '../entitlement/entitlement-consumer.module.js';
import { CATALOG_DATE_TOPIC, payloadOf, wireMessage } from '../itest/entitlement.js';
import {
  cancelSeat,
  errorOf,
  grantSeat,
  newViewer,
  openCall,
  renewCall,
  ticketOf,
  type Playback,
} from '../itest/playback.js';
import {
  MEDIA_SERVER_TEST_SECRET,
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
import { readMediaMtxEnv } from '../media/mediamtx/mediamtx-env.js';
import { MediaMtxHttp } from '../media/mediamtx/mediamtx-http.js';
import { MediaMtxStreamingProvider } from '../media/mediamtx/mediamtx-streaming-provider.js';
import { MEDIA_SERVER_SECRET } from '../media-server/media-server.identity.js';
import { MediaServerModule } from '../media-server/media-server.module.js';
import { PlaybackModule } from '../playback/playback.module.js';
import { ProgressModule } from '../progress/progress.module.js';
import { ReplayAssetSweeperModule } from '../replay-asset/replay-asset-sweeper.module.js';
import { RunConsumerModule } from '../run/run-consumer.module.js';
import { SweepRunPresence } from '../run/run-passes.js';
import { RunSweeperModule } from '../run/run-sweeper.module.js';
import { RunModule } from '../run/run.module.js';
import { STREAM_KEY_SECRET } from '../run/stream-key.js';

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

let stack: StartedStack;
let media: StartedMediaStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let provider: MediaMtxStreamingProvider;
let originApi: MediaMtxHttp;
let edgeApi: MediaMtxHttp;
const clock = new DrillClock();
const live = (): LiveContext => ({ clock, dataSource, desk, playback, media });
let desk: RunDesk;
let playback: Playback;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  dataSource = await applyMigrations(
    await createDatabase(stack.postgres, 'streaming_real_live_drill'),
    STREAMING_SCHEMA,
  );
  // MX1's route on the app itself: the origin asks it before each publish, as in development.
  const apiPort = await freePort();
  media = await startMediaStack({
    authorizeUrl: `http://mediamtx:${MEDIA_SERVER_TEST_SECRET}@host.docker.internal:${String(apiPort)}/v1/media-server/authorize`,
  });
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
      MediaServerModule,
    ],
    providers: EDGE_PROVIDERS,
    dataSource,
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
  await app.listen(apiPort, '0.0.0.0');
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
  await stack.stop();
}, MEDIA_STACK_STOP_MS);

let whip: LiveRun;
let opened: { manifestUrl: string; token: string; expiresAt: Instant; sessionId: string };

describe('a real live through MediaMTX and Envoy', () => {
  it(
    'publishes with the run key, passes the technical check on a real sample, goes on air',
    async () => {
      whip = await preparedRun(live());
      const check = await onAir(live(), whip, 'whip');

      expect(check).toMatchObject({ data: { passed: true, failures: [] } });
      expect((await runRow(live(), whip))?.state).toBe(RunState.ON_AIR);
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
      expect(renewed.statusCode).toBe(403);
      expect(errorOf(renewed).code).toBe(WatchDenialReason.SEAT_EXPIRED);
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
        async () => expect((await runRow(live(), whip))?.publisher_online_since).not.toBeNull(),
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
      const srt = await preparedRun(live());
      await publish(live(), srt, 'srt');
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
      const replayed = await preparedRun(live(), WireReplayPolicy.INCLUDED);
      await onAir(live(), replayed, 'srt');
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
        body: { expectedVersion: (await runRow(live(), replayed))?.version ?? 0 },
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
        async () => expect((await runRow(live(), whip))?.publisher_online_since).toBeNull(),
        { timeout: 30_000, interval: 250 },
      );
      clock.advance((PUBLISHER_GRACE_SECONDS + HOLD_SCREEN_AUTO_AFTER_SECONDS_DEFAULT + 1) * 1_000);
      await desk.commands.execute(new SweepRunPresence());
      await desk.commands.execute(new SweepRunPresence());
      expect((await runRow(live(), whip))?.state).toBe(RunState.INTERRUPTED);

      await publish(live(), whip, 'whip');

      await vi.waitFor(
        async () => expect((await runRow(live(), whip))?.state).toBe(RunState.ON_AIR),
        {
          timeout: 30_000,
          interval: 500,
        },
      );
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
