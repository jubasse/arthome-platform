import type { Logger } from '@nestjs/common';

import { MINUTE_MS, type Clock } from '@arthome/core';

import {
  listPaths,
  livePathOf,
  watchPathOf,
  type MediaMtxPath,
  type MediaMtxTrack,
} from './mediamtx-api.js';
import type { MediaMtxHttp } from './mediamtx-http.js';
import { protocolOfSource } from './path-watcher.js';
import type { IngestLifecycleListener } from '../media-ports.js';

/** A date's edge path outlives its last signature by this, then is removed. */
export const EDGE_ROUTE_IDLE_MS = 10 * MINUTE_MS;

/**
 * `infra/mediamtx/audio-worker.sh`'s `AUDIO_WORKER_GRACE_S`: a feed back within it finds its worker
 *   still reading, so the manifest goes on; back later, the worker is restarted and it starts over,
 *   as the fake's generation does.
 */
export const AUDIO_WORKER_GRACE_MS = 5_000;

/**
 * The worker gives up 12 s after a lost input (its grace, then 1, 2 and 4 s; measured in R0). An
 *   edge path offline this long while the feed is online is a worker that failed for good.
 */
export const AUDIO_WORKER_FAILED_AFTER_MS = 15_000;
export const AUDIO_WORKER_ATTEMPTS = 3;

/** MediaMTX's `alwaysAvailableTracks`: they must match the tracks the source brings (R0). */
interface AlwaysAvailableTrack {
  readonly codec: string;
  readonly sampleRate?: number;
  readonly channelCount?: number;
}

export interface EdgePathConfiguration {
  readonly source: string;
  readonly alwaysAvailable: true;
  readonly alwaysAvailableTracks: readonly AlwaysAvailableTrack[];
  readonly runOnInit?: string;
  readonly runOnInitRestart?: false;
}

/** What the worker always emits: AAC-LC, 48 kHz, stereo. */
const WORKER_AUDIO: AlwaysAvailableTrack = {
  codec: 'MPEG4Audio',
  sampleRate: 48_000,
  channelCount: 2,
};

function audioTrackOf(track: MediaMtxTrack): AlwaysAvailableTrack | null {
  const { sampleRate, channelCount } = track.codecProps ?? {};
  if (sampleRate === undefined || channelCount === undefined) return null;
  return { codec: 'MPEG4Audio', sampleRate, channelCount };
}

/**
 * Null for a feed the edge cannot carry: H.264 with AAC is pulled as it is, H.264 with Opus goes
 *   through the audio worker, anything else is left unrouted.
 */
export function edgePathConfigurationOf(
  feed: MediaMtxPath,
  route: { readonly dateId: string; readonly streamPath: string; readonly generation: number },
  originRtspUrl: string,
): EdgePathConfiguration | null {
  const codecs = feed.tracks2.map((track) => track.codec);
  if (codecs.length !== 2 || !codecs.includes('H264')) return null;
  const video: AlwaysAvailableTrack = { codec: 'H264' };
  const origin = `${originRtspUrl}/${livePathOf(route.streamPath)}`;
  const aac = feed.tracks2.find((track) => track.codec === 'MPEG-4 Audio');
  if (aac !== undefined) {
    const audio = audioTrackOf(aac);
    if (audio === null) return null;
    return { source: origin, alwaysAvailable: true, alwaysAvailableTracks: [video, audio] };
  }
  if (!codecs.includes('Opus')) return null;
  return {
    source: 'publisher',
    alwaysAvailable: true,
    alwaysAvailableTracks: [video, WORKER_AUDIO],
    // The generation is ignored by the script: changing it recreates the path, so the worker.
    runOnInit: `/audio-worker.sh ${origin} ${watchPathOf(route.dateId)} ${String(route.generation)}`,
    runOnInitRestart: false,
  };
}

/** One date's edge path as this replica last wrote it, and its audio worker's health. */
class EdgeRoute {
  public generation = 1;
  public applied: string | null = null;
  private feedOfflineSinceMs: number | null = null;
  private edgeOfflineSinceMs: number | null = null;
  private failureReported = false;

  public constructor(
    public readonly dateId: string,
    public streamPath: string,
    public lastSignedMs: number,
  ) {}

  public feedOffline(nowMs: number): void {
    this.feedOfflineSinceMs ??= nowMs;
    this.edgeOfflineSinceMs = null;
  }

  /** A feed back past the worker's grace, or after its failure, gets a new worker. */
  public feedOnline(nowMs: number): void {
    if (this.feedOfflineSinceMs === null) return;
    const workerGone =
      this.failureReported || nowMs - this.feedOfflineSinceMs >= AUDIO_WORKER_GRACE_MS;
    if (this.applied !== null && workerGone) this.generation += 1;
    this.feedOfflineSinceMs = null;
    this.failureReported = false;
  }

  public written(configuration: string): void {
    this.applied = configuration;
    this.edgeOfflineSinceMs = null;
  }

  /** True once per failure: the edge path offline past the worker's budget, the feed online. */
  public workerFailedBy(nowMs: number, edgeOnline: boolean): boolean {
    if (edgeOnline) {
      this.edgeOfflineSinceMs = null;
      return false;
    }
    this.edgeOfflineSinceMs ??= nowMs;
    if (this.failureReported || nowMs - this.edgeOfflineSinceMs < AUDIO_WORKER_FAILED_AFTER_MS) {
      return false;
    }
    this.failureReported = true;
    return true;
  }

  /** The report did not reach the listener: the next tick tries again. */
  public failureNotReported(): void {
    this.failureReported = false;
  }
}

/**
 * The edge's `watch/<dateId>` paths, one per date signed in the last ten minutes whose feed is
 *   online, written through the edge's Control API (R8). Signing does no I/O: it only remembers the
 *   date. State is this replica's, rebuilt from the next signatures after a restart.
 */
export class EdgeRoutes {
  private readonly routes = new Map<string, EdgeRoute>();
  private readonly unroutable = new Set<string>();

  public constructor(
    private readonly edgeApi: MediaMtxHttp,
    private readonly originRtspUrl: string,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  public remember(dateId: string, streamPath: string): void {
    const nowMs = this.clock.nowMs();
    const route = this.routes.get(dateId);
    if (route === undefined) {
      this.routes.set(dateId, new EdgeRoute(dateId, streamPath, nowMs));
      return;
    }
    route.streamPath = streamPath;
    route.lastSignedMs = nowMs;
  }

  public async reconcile(
    origin: ReadonlyMap<string, MediaMtxPath>,
    listener: IngestLifecycleListener,
  ): Promise<void> {
    await this.removeIdle();
    if (this.routes.size === 0) return;
    const edge = await listPaths(this.edgeApi, 'edge paths read');
    for (const route of this.routes.values()) {
      await this.reconcileRoute(route, origin.get(livePathOf(route.streamPath)), edge, listener);
    }
  }

  private async removeIdle(): Promise<void> {
    const nowMs = this.clock.nowMs();
    for (const route of [...this.routes.values()]) {
      if (nowMs - route.lastSignedMs <= EDGE_ROUTE_IDLE_MS) continue;
      if (route.applied !== null) {
        await this.edgeApi.command({
          operation: 'edge path delete',
          method: 'DELETE',
          path: `/v3/config/paths/delete/${watchPathOf(route.dateId)}`,
        });
      }
      this.routes.delete(route.dateId);
    }
  }

  private async reconcileRoute(
    route: EdgeRoute,
    feed: MediaMtxPath | undefined,
    edge: ReadonlyMap<string, MediaMtxPath>,
    listener: IngestLifecycleListener,
  ): Promise<void> {
    const nowMs = this.clock.nowMs();
    if (feed === undefined || !feed.online || protocolOfSource(feed) === null) {
      route.feedOffline(nowMs);
      return;
    }
    route.feedOnline(nowMs);

    const configuration = edgePathConfigurationOf(feed, route, this.originRtspUrl);
    if (configuration === null) {
      this.unroutableOnce(route.streamPath, feed);
      return;
    }
    const wanted = JSON.stringify(configuration);
    const edgePath = edge.get(watchPathOf(route.dateId));
    if (wanted !== route.applied || edgePath === undefined) {
      await this.edgeApi.command({
        operation: 'edge path replace',
        method: 'POST',
        path: `/v3/config/paths/replace/${watchPathOf(route.dateId)}`,
        body: configuration,
      });
      route.written(wanted);
      return;
    }
    if (configuration.runOnInit === undefined) return;
    if (!route.workerFailedBy(nowMs, edgePath.online)) return;
    try {
      await listener.workerFailed({
        streamPath: route.streamPath,
        attempts: AUDIO_WORKER_ATTEMPTS,
        final: true,
        at: this.clock.now(),
      });
    } catch (error) {
      route.failureNotReported();
      throw error;
    }
  }

  private unroutableOnce(streamPath: string, feed: MediaMtxPath): void {
    const codecs = feed.tracks2.map((track) => track.codec).join(', ');
    const key = `${streamPath} ${codecs}`;
    if (this.unroutable.has(key)) return;
    this.unroutable.add(key);
    this.logger.warn(`a feed in ${codecs}: the edge carries H.264 with AAC or Opus only`);
  }
}
