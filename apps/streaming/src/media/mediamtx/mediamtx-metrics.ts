import { setTimeout as sleep } from 'node:timers/promises';

import type { Clock } from '@arthome/core';

import { getPath, livePathOf, type MediaMtxPath, type MediaMtxTrack } from './mediamtx-api.js';
import type { MediaMtxHttp } from './mediamtx-http.js';
import { protocolOfSource } from './path-watcher.js';
import {
  IngestProtocol,
  MediaCodec,
  type FeedSample,
  type StreamingMetricsProvider,
} from '../media-ports.js';

const CODEC_OF_TRACK: Readonly<Record<string, string>> = {
  H264: MediaCodec.H264,
  'MPEG-4 Audio': MediaCodec.AAC,
  Opus: MediaCodec.OPUS,
};

/** MediaMTX 1.21's audio labels (`formatlabel`); any other track is video. */
const AUDIO_TRACKS: ReadonlySet<string> = new Set([
  'Opus',
  'FLAC',
  'Vorbis',
  'MPEG-4 Audio',
  'MPEG-4 Audio LATM',
  'MPEG-1/2 Audio',
  'AC3',
  'Speex',
  'G726',
  'G722',
  'G711',
  'LPCM',
]);

/**
 * `webrtc_sessions_inbound_rtp_packets_jitter` is RFC 3550 jitter in RTP timestamp units, averaged
 *   over the session's tracks (R0, read in MediaMTX's source): over WHIP's H.264 at 90 kHz and Opus
 *   at 48 kHz, the mean clock is 69 kHz. Exact when both tracks jitter alike.
 */
export const WHIP_MEAN_CLOCK_KHZ = 69;

/** Below this between two readings of the byte counter, the rate is noise. */
const RATE_MIN_SPAN_MS = 500;
const RATE_KEPT_MS = 10_000;
const RATE_SECOND_READING_AFTER_MS = 1_000;

export function codecOfTrack(track: MediaMtxTrack): string {
  return CODEC_OF_TRACK[track.codec] ?? track.codec.toLowerCase();
}

export function codecsOf(path: MediaMtxPath): { videoCodec: string; audioCodec: string } | null {
  const video = path.tracks2.find((track) => !AUDIO_TRACKS.has(track.codec));
  const audio = path.tracks2.find((track) => AUDIO_TRACKS.has(track.codec));
  if (video === undefined || audio === undefined) return null;
  return { videoCodec: codecOfTrack(video), audioCodec: codecOfTrack(audio) };
}

interface Reading {
  readonly bytes: number;
  readonly atMs: number;
}

/** The inbound byte counter's recent readings per feed, from the watcher's ticks and the samples. */
export class ByteRates {
  private readonly readings = new Map<string, Reading[]>();

  public record(streamPath: string, bytes: number, atMs: number): void {
    const kept = (this.readings.get(streamPath) ?? []).filter(
      (reading) => atMs - reading.atMs <= RATE_KEPT_MS && reading.bytes <= bytes,
    );
    kept.push({ bytes, atMs });
    this.readings.set(streamPath, kept);
  }

  /** Null until two readings at least half a second apart are held. */
  public kbps(streamPath: string): number | null {
    const readings = this.readings.get(streamPath) ?? [];
    const latest = readings.at(-1);
    if (latest === undefined) return null;
    const earlier = readings
      .filter((reading) => latest.atMs - reading.atMs >= RATE_MIN_SPAN_MS)
      .at(-1);
    if (earlier === undefined) return null;
    return Math.round(((latest.bytes - earlier.bytes) * 8) / (latest.atMs - earlier.atMs));
  }

  /** Drops the feeds no longer online, so the map holds live feeds only. */
  public retainOnly(streamPaths: ReadonlySet<string>): void {
    for (const streamPath of this.readings.keys()) {
      if (!streamPaths.has(streamPath)) this.readings.delete(streamPath);
    }
  }
}

interface PrometheusLine {
  readonly labels: ReadonlyMap<string, string>;
  readonly value: number;
}

/** The text format's samples of one metric; enough for MediaMTX's flat gauges. */
export function samplesOf(text: string, metric: string): PrometheusLine[] {
  const lines: PrometheusLine[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${metric}{`)) continue;
    const close = line.lastIndexOf('}');
    const labels = new Map<string, string>();
    for (const [, name, value] of line
      .slice(metric.length + 1, close)
      .matchAll(/([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      if (name !== undefined && value !== undefined) labels.set(name, value);
    }
    lines.push({ labels, value: Number(line.slice(close + 1).trim()) });
  }
  return lines;
}

/** The publisher's own line: readers of the same path have sessions too. */
function sessionValueOf(text: string, metric: string, sessionId: string): number | null {
  const line = samplesOf(text, metric).find(({ labels }) => labels.get('id') === sessionId);
  return line === undefined || Number.isNaN(line.value) ? null : line.value;
}

/** `sample` reads the origin only: a path's tracks and counter, and its WHIP session's metrics. */
export class MediaMtxMetrics implements StreamingMetricsProvider {
  public constructor(
    private readonly originApi: MediaMtxHttp,
    private readonly originMetrics: MediaMtxHttp,
    private readonly clock: Clock,
    private readonly byteRates: ByteRates,
    private readonly secondReadingAfterMs: number = RATE_SECOND_READING_AFTER_MS,
  ) {}

  public async sample(streamPath: string): Promise<FeedSample | null> {
    const livePath = livePathOf(streamPath);
    let path = await this.onlinePath(livePath);
    if (path === null) return null;
    const protocol = protocolOfSource(path);
    const codecs = codecsOf(path);
    if (protocol === null || codecs === null) return null;

    this.byteRates.record(streamPath, path.inboundBytes, this.clock.nowMs());
    let ingestUpKbps = this.byteRates.kbps(streamPath);
    if (ingestUpKbps === null) {
      await sleep(this.secondReadingAfterMs);
      path = await this.onlinePath(livePath);
      if (path === null) return null;
      this.byteRates.record(streamPath, path.inboundBytes, this.clock.nowMs());
      ingestUpKbps = this.byteRates.kbps(streamPath) ?? 0;
    }

    const measured = { measuredAt: this.clock.now(), protocol, ...codecs, ingestUpKbps };
    if (protocol !== IngestProtocol.WHIP) return measured;
    const text = await this.originMetrics.text({ operation: 'metrics scrape', path: '/metrics' });
    const sessionId = path.source?.id ?? '';
    const jitter =
      text === null
        ? null
        : sessionValueOf(text, 'webrtc_sessions_inbound_rtp_packets_jitter', sessionId);
    const lost =
      text === null
        ? null
        : sessionValueOf(text, 'webrtc_sessions_inbound_rtp_packets_lost', sessionId);
    return {
      ...measured,
      ...(jitter !== null && { jitterMs: Math.round((jitter / WHIP_MEAN_CLOCK_KHZ) * 10) / 10 }),
      ...(lost !== null && { lostPackets: lost }),
    };
  }

  private async onlinePath(livePath: string): Promise<MediaMtxPath | null> {
    const path = await getPath(this.originApi, 'path read', livePath);
    return path?.online === true ? path : null;
  }
}
