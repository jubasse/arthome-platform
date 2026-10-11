import { randomUUID } from 'node:crypto';

import type { SigningKey } from '@arthome-platform/config';
import { doublingDelays } from '@arthome-platform/messaging';
import {
  SignJWT,
  createLocalJWKSet,
  importJWK,
  jwtVerify,
  type CryptoKey,
  type JWTVerifyGetKey,
} from 'jose';

import { EdgeRenewalMode, PlaybackProtocol } from '@arthome/contracts/streaming';
import { audienceOf, fromEpochMs, toEpochMs, type Clock, type Instant } from '@arthome/core';

import {
  IngestProtocol,
  MediaCodec,
  MonitorPath,
  PlaybackSigningUnavailable,
  RecordingNotFound,
  type FeedSample,
  type IngestDecision,
  type IngestHooks,
  type LiveIngestCapabilities,
  type LiveIngestProvider,
  type PlaybackCapabilities,
  type PlaybackGrant,
  type PlaybackProvider,
  type RecordingCapabilities,
  type RecordingProvider,
  type RecordingRef,
  type RecordingStatus,
  type SignedPlayback,
  type StreamingMetricsProvider,
} from './media-ports.js';

/**
 * How long a worker outlives its publisher, so a short cut at the venue keeps the HLS manifest
 *   (`streaming.md` §6). The fake's own parameter: no domain code reads it.
 */
export const FAKE_WORKER_GRACE_MS = 3_000;

/** Three restarts at increasing delays, then a declared failure, never an endless restart (`streaming.md` §6). */
export const FAKE_WORKER_RESTART_DELAYS_MS: readonly number[] = doublingDelays(1_000, 4_000, 7_000);

export const FAKE_INGEST_CAPABILITIES: LiveIngestCapabilities = {
  protocols: [IngestProtocol.RTMPS, IngestProtocol.SRT, IngestProtocol.WHIP],
  monitorPaths: [MonitorPath.WHEP, MonitorPath.LL_HLS],
  carriedCodecs: {
    [IngestProtocol.RTMPS]: { video: [MediaCodec.H264], audio: [MediaCodec.AAC] },
    [IngestProtocol.SRT]: { video: [MediaCodec.H264], audio: [MediaCodec.AAC] },
    // The audio branch turns a browser's Opus into the AAC that HLS carries (`streaming.md` §6).
    [IngestProtocol.WHIP]: { video: [MediaCodec.H264], audio: [MediaCodec.OPUS] },
  },
};

export const FAKE_PLAYBACK_CAPABILITIES: PlaybackCapabilities = {
  supportsSignedCookies: true,
  supportsQueryTokenRenewal: true,
  protocols: [PlaybackProtocol.HLS],
  drmSystems: [],
  geoRestriction: false,
};

export const FAKE_RECORDING_CAPABILITIES: RecordingCapabilities = {
  recording: true,
  masterAtIngest: true,
};

const PLAYBACK_ALGORITHM = 'ES256';
/** The playback set's audience (`adr-auth.md` §8.1): an edge, never a service, reads it. */
const PLAYBACK_AUDIENCE = audienceOf('cdn');
const PLAYBACK_COOKIE = 'arthome_playback';
const EDGE_ORIGIN = 'https://edge.fake-streaming.invalid';
const INGEST_HOST = 'ingest.fake-streaming.invalid';
const MONITOR_ORIGIN = 'https://monitor.fake-streaming.invalid';
const PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

export interface FakeStreamingOptions {
  readonly signingKey: SigningKey;
  readonly clock: Clock;
  readonly workerGraceMs?: number;
  readonly ingestCapabilities?: Partial<LiveIngestCapabilities>;
  readonly playbackCapabilities?: Partial<PlaybackCapabilities>;
}

/** A measurement as a suite feeds it; the fake stamps the instant and the publisher's protocol. */
export type FeedReading = Omit<FeedSample, 'measuredAt' | 'protocol'>;

interface Publish {
  readonly protocol: IngestProtocol;
  readonly presentedKey: string;
}

interface Stream {
  connected: Publish | null;
  lastPublish: Publish | null;
  offlineAtMs: number | null;
  workerFailed: boolean;
  generation: number;
  reading: { readonly value: FeedReading; readonly measuredAt: Instant } | null;
  restarts: readonly Instant[];
}

interface Recording {
  durationSec: number | null;
}

function refused(reason: string): IngestDecision {
  return { accepted: false, reason };
}

/** A synchronous answer as a port's promise, a throw becoming its rejection. */
function settled<T>(answer: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(answer());
  });
}

function signedPrefixOf(dateId: string, sessionScope: string): string {
  for (const segment of [dateId, sessionScope]) {
    if (!PATH_SEGMENT.test(segment)) throw new Error('a playback path segment must be URL-safe');
  }
  return `/playback/${dateId}/${sessionScope}/`;
}

/** Decoded first, so an encoded `..` cannot climb out of the prefix. */
function isUnderPrefix(path: string, prefix: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  const climbs = decoded.split('/').some((segment) => segment === '.' || segment === '..');
  return !climbs && decoded.startsWith(prefix) && decoded.length > prefix.length;
}

/**
 * The four media ports on one instance, for the suites and for development: everything a real
 *   provider must honour, deterministic under the injected clock. Its instants are computed from
 *   the clock, never waited for. Bound by `MediaModule` only, and refused in production.
 */
export class FakeStreamingProvider
  implements LiveIngestProvider, PlaybackProvider, RecordingProvider, StreamingMetricsProvider
{
  public readonly ingestCapabilities: LiveIngestCapabilities;
  public readonly playbackCapabilities: PlaybackCapabilities;
  public readonly recordingCapabilities: RecordingCapabilities = FAKE_RECORDING_CAPABILITIES;

  private readonly clock: Clock;
  private readonly signingKey: SigningKey;
  private readonly workerGraceMs: number;
  private readonly edgeKeys: JWTVerifyGetKey;
  private privateKey: Promise<CryptoKey> | null = null;
  private hooks: IngestHooks | null = null;
  private readonly streams = new Map<string, Stream>();
  private readonly recordings = new Map<string, Recording>();

  public constructor(options: FakeStreamingOptions) {
    this.clock = options.clock;
    this.signingKey = options.signingKey;
    this.workerGraceMs = options.workerGraceMs ?? FAKE_WORKER_GRACE_MS;
    this.ingestCapabilities = { ...FAKE_INGEST_CAPABILITIES, ...options.ingestCapabilities };
    this.playbackCapabilities = { ...FAKE_PLAYBACK_CAPABILITIES, ...options.playbackCapabilities };
    const { d: _private, ...publicHalf } = options.signingKey.privateJwk;
    this.edgeKeys = createLocalJWKSet({
      keys: [{ ...publicHalf, kid: options.signingKey.keyId, alg: PLAYBACK_ALGORITHM }],
    });
  }

  public attachIngestHooks(hooks: IngestHooks): void {
    if (this.hooks !== null) throw new Error('the ingest hooks are attached once, at boot');
    this.hooks = hooks;
  }

  public ingestUrlFor(protocol: IngestProtocol, streamPath: string): string {
    if (!this.ingestCapabilities.protocols.includes(protocol)) {
      throw new Error(`the fake provider does not ingest ${protocol}`);
    }
    const urls: Readonly<Record<IngestProtocol, string>> = {
      [IngestProtocol.RTMPS]: `rtmps://${INGEST_HOST}/live/${streamPath}`,
      [IngestProtocol.SRT]: `srt://${INGEST_HOST}:9000?streamid=publish:live/${streamPath}`,
      [IngestProtocol.WHIP]: `https://${INGEST_HOST}/live/${streamPath}/whip`,
    };
    return urls[protocol];
  }

  public monitorUrlFor(monitorPath: MonitorPath, streamPath: string): string | null {
    if (!this.ingestCapabilities.monitorPaths.includes(monitorPath)) return null;
    return monitorPath === MonitorPath.WHEP
      ? `${MONITOR_ORIGIN}/monitor/${streamPath}/whep`
      : `${MONITOR_ORIGIN}/monitor/${streamPath}/index.m3u8`;
  }

  /** A feed offered by an encoder: the authorizer decides before anything is accepted. */
  public async publish(
    streamPath: string,
    presentedKey: string,
    feed: { readonly protocol: IngestProtocol },
  ): Promise<IngestDecision> {
    const { protocol } = feed;
    if (!this.ingestCapabilities.protocols.includes(protocol)) {
      return refused(`the provider does not ingest ${protocol}`);
    }
    if (this.hooks === null) return refused('no ingest hooks are attached');
    const decision = await this.hooks.authorizer.authorize({ streamPath, presentedKey, protocol });
    if (!decision.accepted) return decision;

    const stream = this.streamAt(streamPath);
    if (stream.connected !== null) return refused('the path already has a publisher');

    const nowMs = this.clock.nowMs();
    const workerKept =
      !stream.workerFailed &&
      stream.offlineAtMs !== null &&
      nowMs < stream.offlineAtMs + this.workerGraceMs;
    if (!workerKept) stream.generation += 1;
    stream.connected = { protocol, presentedKey };
    stream.lastPublish = stream.connected;
    stream.offlineAtMs = null;
    stream.workerFailed = false;
    await this.hooks.listener.publisherOnline({ streamPath, protocol, at: fromEpochMs(nowMs) });
    return decision;
  }

  /** The publisher lost: a cut at the venue, its worker kept for the grace. */
  public async drop(streamPath: string): Promise<void> {
    if (!this.isConnected(streamPath)) throw new Error('no publisher to drop on that path');
    await this.goOffline(streamPath);
  }

  /** The same encoder back, with the key it presented: authorised again, as a real server does. */
  public async resume(streamPath: string): Promise<IngestDecision> {
    const last = this.streams.get(streamPath)?.lastPublish ?? null;
    if (last === null || this.isConnected(streamPath)) {
      throw new Error('no dropped publisher to resume on that path');
    }
    return this.publish(streamPath, last.presentedKey, last);
  }

  public async disconnect(streamPath: string): Promise<void> {
    if (this.isConnected(streamPath)) await this.goOffline(streamPath);
  }

  /** 0 before the first feed; moves each time the HLS manifest restarts from zero. */
  public manifestGeneration(streamPath: string): number {
    return this.streams.get(streamPath)?.generation ?? 0;
  }

  /** The worker crashes for good: three restarts, then one final report. */
  public async failWorker(streamPath: string): Promise<void> {
    const listener = this.attachedHooks().listener;
    const stream = this.streamAt(streamPath);
    let atMs = this.clock.nowMs();
    stream.restarts = FAKE_WORKER_RESTART_DELAYS_MS.map((delayMs) => {
      atMs += delayMs;
      return fromEpochMs(atMs);
    });
    stream.workerFailed = true;
    await listener.workerFailed({
      streamPath,
      attempts: stream.restarts.length,
      final: true,
      at: fromEpochMs(atMs),
    });
  }

  public workerRestartsOf(streamPath: string): readonly Instant[] {
    return this.streams.get(streamPath)?.restarts ?? [];
  }

  public setFeedSample(streamPath: string, reading: FeedReading): void {
    this.streamAt(streamPath).reading = { value: reading, measuredAt: this.clock.now() };
  }

  /** Null too while nothing was measured on the connected feed. */
  public sample(streamPath: string): Promise<FeedSample | null> {
    return settled(() => {
      const stream = this.streams.get(streamPath);
      const connected = stream?.connected ?? null;
      const reading = stream?.reading ?? null;
      if (connected === null || reading === null) return null;
      const { jitterMs, lostPackets, ...measured } = reading.value;
      const overWhip = connected.protocol === IngestProtocol.WHIP;
      return {
        ...measured,
        measuredAt: reading.measuredAt,
        protocol: connected.protocol,
        ...(overWhip && jitterMs !== undefined && { jitterMs }),
        ...(overWhip && lostPackets !== undefined && { lostPackets }),
      };
    });
  }

  public start(streamPath: string): Promise<RecordingRef> {
    return settled(() => {
      if (!this.recordingCapabilities.recording) {
        throw new Error(`the fake provider records nothing, ${streamPath} included`);
      }
      const ref = `rec_${randomUUID()}` as RecordingRef;
      this.recordings.set(ref, { durationSec: null });
      return ref;
    });
  }

  public stop(ref: RecordingRef): Promise<void> {
    return settled(() => {
      this.recordingOf(ref);
    });
  }

  public status(ref: RecordingRef): Promise<RecordingStatus> {
    return settled(() => {
      const { durationSec } = this.recordingOf(ref);
      return { ready: durationSec !== null, durationSec };
    });
  }

  public delete(ref: RecordingRef): Promise<void> {
    return settled(() => {
      this.recordings.delete(ref);
    });
  }

  /** The provider finished processing the recording. */
  public markReady(ref: RecordingRef, durationSec: number): void {
    this.recordingOf(ref).durationSec = durationSec;
  }

  public async sign(grant: PlaybackGrant): Promise<SignedPlayback> {
    const byCookie = grant.mechanism === EdgeRenewalMode.SIGNED_COOKIE;
    const declared = byCookie
      ? this.playbackCapabilities.supportsSignedCookies
      : this.playbackCapabilities.supportsQueryTokenRenewal;
    if (!declared) throw new PlaybackSigningUnavailable(grant.mechanism);

    const prefix = signedPrefixOf(grant.dateId, grant.sessionScope);
    const token = await new SignJWT({ ...grant.claims, prefix })
      .setProtectedHeader({ alg: PLAYBACK_ALGORITHM, kid: this.signingKey.keyId })
      .setAudience(PLAYBACK_AUDIENCE)
      .setExpirationTime(Math.floor(toEpochMs(grant.expiresAt) / 1_000))
      .sign(await this.key());
    return {
      manifestUrl: `${EDGE_ORIGIN}${prefix}master.m3u8`,
      queryToken: byCookie ? null : token,
      cookies: byCookie
        ? [{ name: PLAYBACK_COOKIE, value: token, path: prefix, expiresAt: grant.expiresAt }]
        : [],
      keyId: this.signingKey.keyId,
    };
  }

  /**
   * What the edge decides for one request: a signature by a known `kid`, a path under the signed
   *   prefix, and `at` before the token's `exp`. A suite measures playback stopping with it, not
   *   the renewal being refused (`adr-stream-entitlement.md` §3.3).
   */
  public async edgeServes(path: string, credential: string, at: Instant): Promise<boolean> {
    try {
      const { payload, protectedHeader } = await jwtVerify(credential, this.edgeKeys, {
        algorithms: [PLAYBACK_ALGORITHM],
        audience: PLAYBACK_AUDIENCE,
        requiredClaims: ['exp'],
        currentDate: new Date(toEpochMs(at)),
      });
      return (
        protectedHeader.kid !== undefined &&
        typeof payload.prefix === 'string' &&
        isUnderPrefix(path, payload.prefix)
      );
    } catch {
      return false;
    }
  }

  private isConnected(streamPath: string): boolean {
    return (this.streams.get(streamPath)?.connected ?? null) !== null;
  }

  private attachedHooks(): IngestHooks {
    if (this.hooks === null) throw new Error('no ingest hooks are attached');
    return this.hooks;
  }

  private streamAt(streamPath: string): Stream {
    let stream = this.streams.get(streamPath);
    if (stream === undefined) {
      stream = {
        connected: null,
        lastPublish: null,
        offlineAtMs: null,
        workerFailed: false,
        generation: 0,
        reading: null,
        restarts: [],
      };
      this.streams.set(streamPath, stream);
    }
    return stream;
  }

  private async goOffline(streamPath: string): Promise<void> {
    const listener = this.attachedHooks().listener;
    const stream = this.streamAt(streamPath);
    const nowMs = this.clock.nowMs();
    stream.connected = null;
    stream.offlineAtMs = nowMs;
    await listener.publisherOffline({ streamPath, at: fromEpochMs(nowMs) });
  }

  private recordingOf(ref: RecordingRef): Recording {
    const recording = this.recordings.get(ref);
    if (recording === undefined) throw new RecordingNotFound();
    return recording;
  }

  private key(): Promise<CryptoKey> {
    this.privateKey ??= importJWK(
      { ...this.signingKey.privateJwk },
      PLAYBACK_ALGORITHM,
    ) as Promise<CryptoKey>;
    return this.privateKey;
  }
}
