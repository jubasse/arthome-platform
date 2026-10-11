import { accessorOf, type AccessorOf, type HandlerInput } from '@arthome/contracts/http';
import type { streamingServiceApi } from '@arthome/contracts/streaming-service-api';

import { IngestProtocol, type IngestAttempt } from '../media/media-ports.js';

/**
 * MediaMTX's words for what an attempt does and how it arrives (`authenticateHTTP`). Any other value
 *   is kept raw and refused, never a 400 (critical rule 10).
 */
export const MEDIA_SERVER_ACTIONS = [
  'publish',
  'read',
  'playback',
  'api',
  'metrics',
  'pprof',
] as const;
export const MediaServerAction: AccessorOf<typeof MEDIA_SERVER_ACTIONS> =
  accessorOf(MEDIA_SERVER_ACTIONS);

export const MEDIA_SERVER_PROTOCOLS = ['rtsp', 'rtmp', 'hls', 'webrtc', 'srt'] as const;
export const MediaServerProtocol: AccessorOf<typeof MEDIA_SERVER_PROTOCOLS> =
  accessorOf(MEDIA_SERVER_PROTOCOLS);

/** The origin publishes every feed under this prefix, followed by the run's stream path. */
export const LIVE_PATH_PREFIX = 'live/';

/** The ingest each protocol carries; RTMPS joins once MediaMTX's origin declares it. */
const INGEST_OF: Readonly<Record<string, IngestProtocol>> = {
  [MediaServerProtocol.WEBRTC]: IngestProtocol.WHIP,
  [MediaServerProtocol.SRT]: IngestProtocol.SRT,
};

export const MediaServerRefusal = {
  NOT_A_PUBLISH: 'only a publish is decided here',
  NO_INGEST_PROTOCOL: 'the protocol carries no ingest',
  NOT_A_LIVE_PATH: 'the path names no live feed',
  NO_KEY: 'no stream key was presented',
} as const;
export type MediaServerRefusal = (typeof MediaServerRefusal)[keyof typeof MediaServerRefusal];

export type MediaServerAuthorization = HandlerInput<
  typeof streamingServiceApi.routes.authorizeMediaServerAccess
>['body'];

export type MediaServerAttempt =
  | { readonly kind: 'publish'; readonly attempt: IngestAttempt }
  | { readonly kind: 'refusal'; readonly reason: MediaServerRefusal };

/**
 * What MediaMTX asks, as the run's ingest authoriser reads it. WHIP's `Authorization: Bearer <key>`
 *   arrives as `token`, SRT's `publish:live/<path>:<user>:<key>` streamid as `password`.
 */
export function attemptOf(request: MediaServerAuthorization): MediaServerAttempt {
  if (request.action !== MediaServerAction.PUBLISH)
    return refused(MediaServerRefusal.NOT_A_PUBLISH);
  const protocol = Object.hasOwn(INGEST_OF, request.protocol)
    ? INGEST_OF[request.protocol]
    : undefined;
  if (protocol === undefined) return refused(MediaServerRefusal.NO_INGEST_PROTOCOL);
  const streamPath = request.path.startsWith(LIVE_PATH_PREFIX)
    ? request.path.slice(LIVE_PATH_PREFIX.length)
    : '';
  if (streamPath === '' || streamPath.includes('/')) {
    return refused(MediaServerRefusal.NOT_A_LIVE_PATH);
  }
  const presentedKey = nonEmpty(request.token) ?? nonEmpty(request.password);
  if (presentedKey === undefined) return refused(MediaServerRefusal.NO_KEY);
  return { kind: 'publish', attempt: { streamPath, presentedKey, protocol } };
}

function refused(reason: MediaServerRefusal): MediaServerAttempt {
  return { kind: 'refusal', reason };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
