import { accessorOf, type AccessorOf } from '@arthome/contracts/http';
import type {
  DrmSystem,
  EdgeRenewalMode,
  PlaybackProtocol,
  QualityCap,
} from '@arthome/contracts/streaming';
import type { Instant, WatchScope } from '@arthome/core';

/**
 * The media plane behind four ports (`streaming.md` §3): what a provider can do is declared in its
 *   capabilities, and nothing it names crosses into the domain. The stream path is the domain's,
 *   random and unpredictable; a recording reference is the provider's, opaque. They live here
 *   rather than in core while `streaming` alone implements and calls them. Each port names its
 *   capabilities after itself, since one provider may implement all four.
 */

export const INGEST_PROTOCOLS = ['rtmps', 'srt', 'whip'] as const;
export type IngestProtocol = (typeof INGEST_PROTOCOLS)[number];

export const IngestProtocol: AccessorOf<typeof INGEST_PROTOCOLS> = accessorOf(INGEST_PROTOCOLS);

/** How the run desk watches the feed: WHEP is never promised (D-019), LL-HLS always is. */
export const MONITOR_PATHS = ['whep', 'll_hls'] as const;
export type MonitorPath = (typeof MONITOR_PATHS)[number];

export const MonitorPath: AccessorOf<typeof MONITOR_PATHS> = accessorOf(MONITOR_PATHS);

/** The codecs a fake or a real chain names; a sample may carry any other, kept raw. */
export const MediaCodec = {
  H264: 'h264',
  AAC: 'aac',
  OPUS: 'opus',
} as const;

export interface CarriedCodecs {
  readonly video: readonly string[];
  readonly audio: readonly string[];
}

export interface LiveIngestCapabilities {
  readonly protocols: readonly IngestProtocol[];
  readonly monitorPaths: readonly MonitorPath[];
  /** Per declared protocol: core names no codec, so the check reads them here (D-114). */
  readonly carriedCodecs: Readonly<Partial<Record<IngestProtocol, CarriedCodecs>>>;
}

export interface IngestAttempt {
  readonly streamPath: string;
  /** Never logged, nor any value derived from it. */
  readonly presentedKey: string;
  readonly protocol: IngestProtocol;
}

export type IngestDecision =
  { readonly accepted: true } | { readonly accepted: false; readonly reason: string };

/** The provider's synchronous call into the domain, before any feed is accepted (`adr-stream-entitlement.md` §6). */
export interface IngestAuthorizer {
  authorize(attempt: IngestAttempt): Promise<IngestDecision>;
}

export interface PublisherOnline {
  readonly streamPath: string;
  readonly protocol: IngestProtocol;
  readonly at: Instant;
}

export interface PublisherOffline {
  readonly streamPath: string;
  readonly at: Instant;
}

export interface WorkerFailed {
  readonly streamPath: string;
  readonly attempts: number;
  /** True once the provider stopped restarting it: never an endless restart (`streaming.md` §6). */
  readonly final: boolean;
  readonly at: Instant;
}

/** What the provider reports of a feed's life. It decides nothing (`adr-stream-entitlement.md` §6). */
export interface IngestLifecycleListener {
  publisherOnline(event: PublisherOnline): Promise<void>;
  publisherOffline(event: PublisherOffline): Promise<void>;
  workerFailed(event: WorkerFailed): Promise<void>;
}

export interface IngestHooks {
  readonly authorizer: IngestAuthorizer;
  readonly listener: IngestLifecycleListener;
}

export interface LiveIngestProvider {
  readonly ingestCapabilities: LiveIngestCapabilities;
  /** Once, at boot: until then every feed is refused. */
  attachIngestHooks(hooks: IngestHooks): void;
  ingestUrlFor(protocol: IngestProtocol, streamPath: string): string;
  /** Null when the provider does not offer that path. */
  monitorUrlFor(monitorPath: MonitorPath, streamPath: string): string | null;
  disconnect(streamPath: string): Promise<void>;
}

/** The value of `TechnicalCheckProbe.codecCarried` for a sample: both its codecs, on its protocol. */
export function codecsCarried(capabilities: LiveIngestCapabilities, sample: FeedSample): boolean {
  const carried = capabilities.carriedCodecs[sample.protocol];
  return (
    carried !== undefined &&
    carried.video.includes(sample.videoCodec) &&
    carried.audio.includes(sample.audioCodec)
  );
}

export interface PlaybackCapabilities {
  readonly supportsSignedCookies: boolean;
  readonly supportsQueryTokenRenewal: boolean;
  readonly protocols: readonly PlaybackProtocol[];
  readonly drmSystems: readonly DrmSystem[];
  readonly geoRestriction: boolean;
}

/** The playback token's claims (`adr-stream-entitlement.md` §3.1); `exp` is the grant's `expiresAt`. */
export interface PlaybackClaims {
  /** The profile. */
  readonly sub: string;
  readonly did: string;
  readonly dat: string;
  readonly sid: string;
  readonly qmax: QualityCap;
  readonly scope: typeof WatchScope.FULL | typeof WatchScope.PREVIEW;
  readonly jti: string;
}

export interface PlaybackGrant {
  readonly dateId: string;
  readonly sessionScope: string;
  readonly claims: PlaybackClaims;
  readonly expiresAt: Instant;
  readonly mechanism: EdgeRenewalMode;
}

export interface PlaybackCookie {
  readonly name: string;
  /** The signed token: never logged. */
  readonly value: string;
  readonly path: string;
  readonly expiresAt: Instant;
}

export interface SignedPlayback {
  /** Stable across renewals: the signature never sits in it (`adr-stream-entitlement.md` §3.2). */
  readonly manifestUrl: string;
  /** Null unless the mechanism is `query_token`; never logged. */
  readonly queryToken: string | null;
  /** Empty unless the mechanism is `signed_cookie`. */
  readonly cookies: readonly PlaybackCookie[];
  readonly keyId: string;
}

/** A port that cannot sign the requested way refuses to serve, never serves unsigned. */
export class PlaybackSigningUnavailable extends Error {
  public constructor(public readonly mechanism: EdgeRenewalMode) {
    super(`the playback provider does not sign by ${mechanism}`);
    this.name = 'PlaybackSigningUnavailable';
  }
}

export interface PlaybackProvider {
  readonly playbackCapabilities: PlaybackCapabilities;
  sign(grant: PlaybackGrant): Promise<SignedPlayback>;
}

declare const recordingRefBrand: unique symbol;

/** The provider's name for a recording, stored by the domain and never read. */
export type RecordingRef = string & { readonly [recordingRefBrand]: true };

export function recordingRefOf(stored: string): RecordingRef {
  return stored as RecordingRef;
}

export interface RecordingCapabilities {
  readonly recording: boolean;
  /** The master stream recorded at ingest, so a replay can be regenerated (`streaming.md` §4). */
  readonly masterAtIngest: boolean;
}

export interface RecordingStatus {
  readonly ready: boolean;
  /** Null until ready. */
  readonly durationSec: number | null;
}

export class RecordingNotFound extends Error {
  public constructor() {
    super('the recording provider holds no such recording');
    this.name = 'RecordingNotFound';
  }
}

export interface RecordingProvider {
  readonly recordingCapabilities: RecordingCapabilities;
  start(streamPath: string): Promise<RecordingRef>;
  stop(ref: RecordingRef): Promise<void>;
  /** Throws `RecordingNotFound` for a reference the provider does not hold. */
  status(ref: RecordingRef): Promise<RecordingStatus>;
  /** Deleting what is already gone is not an error. */
  delete(ref: RecordingRef): Promise<void>;
}

export interface FeedSample {
  readonly measuredAt: Instant;
  readonly protocol: IngestProtocol;
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly ingestUpKbps: number;
  /** WHIP only, absent otherwise. */
  readonly jitterMs?: number;
  /** WHIP only, absent otherwise. */
  readonly lostPackets?: number;
}

export interface StreamingMetricsProvider {
  /** Null while no publisher is connected. */
  sample(streamPath: string): Promise<FeedSample | null>;
}
