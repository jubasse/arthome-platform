import type { MediaMtxHttp } from './mediamtx-http.js';

/** The fields read of MediaMTX 1.21's `APIPath`; the rest is ignored. */
export interface MediaMtxPath {
  readonly name: string;
  readonly online: boolean;
  readonly onlineTime: string | null;
  readonly source: { readonly type: string; readonly id: string } | null;
  readonly tracks2: readonly MediaMtxTrack[];
  readonly inboundBytes: number;
}

export interface MediaMtxTrack {
  readonly codec: string;
  readonly codecProps?: { readonly sampleRate?: number; readonly channelCount?: number };
}

interface MediaMtxPage<T> {
  readonly pageCount: number;
  readonly items: readonly T[];
}

export const LIVE_PREFIX = 'live/';
export const WATCH_PREFIX = 'watch/';
const PAGE_SIZE = 500;

export function livePathOf(streamPath: string): string {
  return `${LIVE_PREFIX}${streamPath}`;
}

export function watchPathOf(dateId: string): string {
  return `${WATCH_PREFIX}${dateId}`;
}

/** Every runtime path of one instance, by name. */
export async function listPaths(
  api: MediaMtxHttp,
  operation: string,
): Promise<Map<string, MediaMtxPath>> {
  const paths = new Map<string, MediaMtxPath>();
  for (let page = 0, pageCount = 1; page < pageCount; page += 1) {
    const answer = await api.json<MediaMtxPage<MediaMtxPath>>({
      operation,
      path: '/v3/paths/list',
      query: { page: String(page), itemsPerPage: String(PAGE_SIZE) },
    });
    if (answer === null) throw new Error(`${operation}: the paths list answered 404`);
    for (const path of answer.items) paths.set(path.name, path);
    pageCount = answer.pageCount;
  }
  return paths;
}

export function getPath(
  api: MediaMtxHttp,
  operation: string,
  name: string,
): Promise<MediaMtxPath | null> {
  return api.json<MediaMtxPath>({ operation, path: `/v3/paths/get/${name}` });
}
