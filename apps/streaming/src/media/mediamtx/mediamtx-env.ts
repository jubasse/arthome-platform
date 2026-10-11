import { z } from 'zod';

export const StreamingMediaProvider = {
  FAKE: 'fake',
  MEDIAMTX: 'mediamtx',
} as const;
export type StreamingMediaProvider =
  (typeof StreamingMediaProvider)[keyof typeof StreamingMediaProvider];

export interface MediaMtxEnv {
  readonly originApiUrl: string;
  readonly originMetricsUrl: string;
  readonly originPlaybackUrl: string;
  /** The origin's RTSP server as the edge reaches it, on the media network. */
  readonly originRtspUrl: string;
  readonly edgeApiUrl: string;
  /** WHIP for encoders, WHEP for the studio monitor: one origin port. */
  readonly webRtcUrl: string;
  readonly srtUrl: string;
  readonly monitorHlsUrl: string;
  /** Envoy, the only door to the edge's HLS. */
  readonly playbackEdgeUrl: string;
  readonly watchEveryMs: number;
}

const httpUrl = z.url({ protocol: /^https?$/ });

const mediaMtxSchema = z.object({
  MEDIAMTX_ORIGIN_API_URL: httpUrl,
  MEDIAMTX_ORIGIN_METRICS_URL: httpUrl,
  MEDIAMTX_ORIGIN_PLAYBACK_URL: httpUrl,
  MEDIAMTX_ORIGIN_RTSP_URL: z.url({ protocol: /^rtsp$/ }),
  MEDIAMTX_EDGE_API_URL: httpUrl,
  MEDIAMTX_WEBRTC_URL: httpUrl,
  MEDIAMTX_SRT_URL: z.url({ protocol: /^srt$/ }),
  MEDIAMTX_MONITOR_HLS_URL: httpUrl,
  MEDIAMTX_PLAYBACK_EDGE_URL: httpUrl,
  MEDIAMTX_WATCH_EVERY_MS: z.coerce.number().int().min(100).max(10_000).default(1_000),
});

function withoutEmpty(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function readStreamingMediaProvider(
  source: Record<string, string | undefined> = process.env,
): StreamingMediaProvider {
  return z
    .object({
      STREAMING_MEDIA_PROVIDER: z
        .enum([StreamingMediaProvider.FAKE, StreamingMediaProvider.MEDIAMTX])
        .default(StreamingMediaProvider.FAKE),
    })
    .parse(withoutEmpty(source)).STREAMING_MEDIA_PROVIDER;
}

/** Read only when `mediamtx` is selected: every URL is required, so a missing one fails the boot. */
export function readMediaMtxEnv(
  source: Record<string, string | undefined> = process.env,
): MediaMtxEnv {
  const parsed = mediaMtxSchema.parse(withoutEmpty(source));
  return {
    originApiUrl: withoutTrailingSlash(parsed.MEDIAMTX_ORIGIN_API_URL),
    originMetricsUrl: withoutTrailingSlash(parsed.MEDIAMTX_ORIGIN_METRICS_URL),
    originPlaybackUrl: withoutTrailingSlash(parsed.MEDIAMTX_ORIGIN_PLAYBACK_URL),
    originRtspUrl: withoutTrailingSlash(parsed.MEDIAMTX_ORIGIN_RTSP_URL),
    edgeApiUrl: withoutTrailingSlash(parsed.MEDIAMTX_EDGE_API_URL),
    webRtcUrl: withoutTrailingSlash(parsed.MEDIAMTX_WEBRTC_URL),
    srtUrl: withoutTrailingSlash(parsed.MEDIAMTX_SRT_URL),
    monitorHlsUrl: withoutTrailingSlash(parsed.MEDIAMTX_MONITOR_HLS_URL),
    playbackEdgeUrl: withoutTrailingSlash(parsed.MEDIAMTX_PLAYBACK_EDGE_URL),
    watchEveryMs: parsed.MEDIAMTX_WATCH_EVERY_MS,
  };
}
