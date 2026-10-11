import type { SigningKey } from '@arthome-platform/config';
import { Logger, type BeforeApplicationShutdown } from '@nestjs/common';

import { EdgeRenewalMode, PlaybackProtocol } from '@arthome/contracts/streaming';
import type { Clock } from '@arthome/core';

import { EdgeRoutes } from './edge-routes.js';
import {
  LIVE_PREFIX,
  getPath,
  listPaths,
  livePathOf,
  watchPathOf,
  type MediaMtxPath,
} from './mediamtx-api.js';
import type { MediaMtxEnv } from './mediamtx-env.js';
import { MediaMtxCallFailed, MediaMtxHttp } from './mediamtx-http.js';
import { ByteRates, MediaMtxMetrics } from './mediamtx-metrics.js';
import { MediaMtxRecording } from './mediamtx-recording.js';
import { PathWatcher, protocolOfSource } from './path-watcher.js';
import {
  IngestProtocol,
  MediaCodec,
  MonitorPath,
  PlaybackSigningUnavailable,
  type FeedSample,
  type IngestHooks,
  type LiveIngestCapabilities,
  type LiveIngestProvider,
  type PlaybackCapabilities,
  type PlaybackGrant,
  type PlaybackProvider,
  type RecordingProvider,
  type RecordingRef,
  type RecordingStatus,
  type SignedPlayback,
  type StreamingMetricsProvider,
} from '../media-ports.js';
import { PlaybackTokenSigner, assertUrlSafeSegment } from '../playback-token.js';

export const MEDIAMTX_INGEST_CAPABILITIES: LiveIngestCapabilities = {
  protocols: [IngestProtocol.WHIP, IngestProtocol.SRT],
  monitorPaths: [MonitorPath.WHEP, MonitorPath.LL_HLS],
  carriedCodecs: {
    // The edge's audio worker turns a browser's Opus into the AAC that HLS carries (`streaming.md` §6).
    [IngestProtocol.WHIP]: { video: [MediaCodec.H264], audio: [MediaCodec.OPUS] },
    [IngestProtocol.SRT]: { video: [MediaCodec.H264], audio: [MediaCodec.AAC] },
  },
};

export const MEDIAMTX_PLAYBACK_CAPABILITIES: PlaybackCapabilities = {
  supportsSignedCookies: false,
  // The player re-applies the current token to each request (`adr-stream-entitlement.md` §3.2).
  supportsQueryTokenRenewal: true,
  protocols: [PlaybackProtocol.HLS],
  drmSystems: [],
  geoRestriction: false,
  // Envoy checks every request: a refused renewal stops playback at `exp` (§3.3).
  checksEveryRequest: true,
};

/** The Control API's kick route per publishing source type. */
const KICK_ROUTE: Readonly<Record<IngestProtocol, string | null>> = {
  [IngestProtocol.WHIP]: '/v3/webrtc/sessions/kick/',
  [IngestProtocol.SRT]: '/v3/srt/conns/kick/',
  [IngestProtocol.RTMPS]: null,
};

export interface MediaMtxOptions {
  readonly env: MediaMtxEnv;
  readonly signingKey: SigningKey;
  readonly clock: Clock;
}

/**
 * The four media ports on MediaMTX (`compose.media.yaml`): encoders publish to the origin, which
 *   asks the streaming API before each publish (MX1's route, not this class); viewers read the
 *   edge through Envoy, which checks the playback token on every request. No byte of video passes
 *   through here: only the Control APIs, the metrics endpoint and the playback server's `/list`.
 *   A feed's life is read by polling the origin (R6), which also reconciles the edge's paths.
 */
export class MediaMtxStreamingProvider
  implements
    LiveIngestProvider,
    PlaybackProvider,
    RecordingProvider,
    StreamingMetricsProvider,
    BeforeApplicationShutdown
{
  public readonly ingestCapabilities = MEDIAMTX_INGEST_CAPABILITIES;
  public readonly playbackCapabilities = MEDIAMTX_PLAYBACK_CAPABILITIES;
  public readonly recordingCapabilities;

  private readonly logger = new Logger(MediaMtxStreamingProvider.name);
  private readonly env: MediaMtxEnv;
  private readonly clock: Clock;
  private readonly originApi: MediaMtxHttp;
  private readonly signer: PlaybackTokenSigner;
  private readonly byteRates = new ByteRates();
  private readonly edgeRoutes: EdgeRoutes;
  private readonly metrics: MediaMtxMetrics;
  private readonly recording: MediaMtxRecording;
  private watch: WatchLoop | null = null;

  public constructor({ env, signingKey, clock }: MediaMtxOptions) {
    this.env = env;
    this.clock = clock;
    this.originApi = new MediaMtxHttp('the origin', env.originApiUrl);
    this.signer = new PlaybackTokenSigner(signingKey);
    this.edgeRoutes = new EdgeRoutes(
      new MediaMtxHttp('the edge', env.edgeApiUrl),
      env.originRtspUrl,
      clock,
      this.logger,
    );
    this.metrics = new MediaMtxMetrics(
      this.originApi,
      new MediaMtxHttp('the origin metrics', env.originMetricsUrl),
      clock,
      this.byteRates,
    );
    this.recording = new MediaMtxRecording(
      this.originApi,
      new MediaMtxHttp('the origin playback server', env.originPlaybackUrl),
      clock,
    );
    this.recordingCapabilities = this.recording.recordingCapabilities;
  }

  /** Starts the watcher: the authorizer is MX1's route's, which the origin calls by itself. */
  public attachIngestHooks(hooks: IngestHooks): void {
    if (this.watch !== null) throw new Error('the ingest hooks are attached once, at boot');
    const watcher = new PathWatcher(hooks.listener, this.logger);
    this.watch = new WatchLoop(this.env.watchEveryMs, this.logger, async () => {
      const readAt = this.clock.now();
      const origin = await listPaths(this.originApi, 'origin paths read');
      this.recordByteCounters(origin);
      await watcher.observe(origin, readAt);
      await this.edgeRoutes.reconcile(origin, hooks.listener);
    });
  }

  private recordByteCounters(origin: ReadonlyMap<string, MediaMtxPath>): void {
    const nowMs = this.clock.nowMs();
    const online = new Set<string>();
    for (const path of origin.values()) {
      if (!path.name.startsWith(LIVE_PREFIX) || !path.online) continue;
      const streamPath = path.name.slice(LIVE_PREFIX.length);
      online.add(streamPath);
      this.byteRates.record(streamPath, path.inboundBytes, nowMs);
    }
    this.byteRates.retainOnly(online);
  }

  public async beforeApplicationShutdown(): Promise<void> {
    await this.watch?.stop();
  }

  public ingestUrlFor(protocol: IngestProtocol, streamPath: string): string {
    const name = livePathOf(streamPath);
    switch (protocol) {
      case IngestProtocol.WHIP:
        return `${this.env.webRtcUrl}/${name}/whip`;
      case IngestProtocol.SRT:
        // The encoder appends `:<user>:<key>` (MX1 §6 S4).
        return `${this.env.srtUrl}?streamid=publish:${name}`;
      case IngestProtocol.RTMPS:
        throw new Error('the MediaMTX provider does not ingest rtmps');
    }
  }

  public monitorUrlFor(monitorPath: MonitorPath, streamPath: string): string {
    const name = livePathOf(streamPath);
    return monitorPath === MonitorPath.WHEP
      ? `${this.env.webRtcUrl}/${name}/whep`
      : `${this.env.monitorHlsUrl}/${name}/index.m3u8`;
  }

  /** Kicks the publishing session; a feed already gone is not an error. */
  public async disconnect(streamPath: string): Promise<void> {
    const path = await getPath(this.originApi, 'path read', livePathOf(streamPath));
    const protocol = path === null ? null : protocolOfSource(path);
    if (path?.source == null || protocol === null) return;
    const kick = KICK_ROUTE[protocol];
    if (kick === null) return;
    await this.originApi.command({
      operation: 'publisher kick',
      method: 'POST',
      path: `${kick}${path.source.id}`,
    });
  }

  public async sign(grant: PlaybackGrant): Promise<SignedPlayback> {
    if (grant.mechanism === EdgeRenewalMode.SIGNED_COOKIE) {
      throw new PlaybackSigningUnavailable(grant.mechanism);
    }
    assertUrlSafeSegment(grant.dateId);
    if (grant.streamPath !== null) this.edgeRoutes.remember(grant.dateId, grant.streamPath);
    const prefix = `/${watchPathOf(grant.dateId)}/`;
    return {
      manifestUrl: `${this.env.playbackEdgeUrl}${prefix}index.m3u8`,
      queryToken: await this.signer.sign(grant, prefix),
      cookies: [],
      keyId: this.signer.keyId,
    };
  }

  public sample(streamPath: string): Promise<FeedSample | null> {
    return this.metrics.sample(streamPath);
  }

  public start(streamPath: string): Promise<RecordingRef> {
    return this.recording.start(streamPath);
  }

  public stop(ref: RecordingRef): Promise<void> {
    return this.recording.stop(ref);
  }

  public status(ref: RecordingRef): Promise<RecordingStatus> {
    return this.recording.status(ref);
  }

  public delete(ref: RecordingRef): Promise<void> {
    return this.recording.delete(ref);
  }
}

/**
 * The `SweeperLoop` shape, started by `attachIngestHooks` rather than at bootstrap, so only the
 *   process holding the hooks polls. A tick never overlaps the previous one; a failed read reports
 *   nothing (an unreachable origin is never "every feed offline"), logged once until it recovers.
 */
class WatchLoop {
  private stopping = false;
  private failing = false;
  private wake: () => void = () => undefined;
  private readonly running: Promise<void>;

  public constructor(
    private readonly everyMs: number,
    private readonly logger: Logger,
    private readonly tick: () => Promise<void>,
  ) {
    this.running = this.loop();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    this.wake();
    await this.running;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.tick();
        if (this.failing) this.logger.log('the media server answers again');
        this.failing = false;
      } catch (error) {
        if (!this.failing) {
          this.logger.warn(`a watch tick failed, retried every tick: ${messageOf(error)}`);
        }
        this.failing = true;
      }
      if (this.stopping) break;
      await this.pause();
    }
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.everyMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

/** `MediaMtxCallFailed` names a server and an operation only (R15); anything else, its name. */
function messageOf(error: unknown): string {
  if (error instanceof MediaMtxCallFailed) return error.message;
  return error instanceof Error ? error.name : typeof error;
}
