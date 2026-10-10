import { headersFor, type CallOptions, type Playback, type Viewer } from './playback.js';

export interface RecordOptions extends CallOptions {
  readonly body?: Record<string, unknown>;
}

export async function recordCall(
  playback: Playback,
  viewer: Viewer,
  dateId: string,
  positionSec: number,
  options: RecordOptions = {},
) {
  return playback.app.inject({
    method: 'PUT',
    url: `/v1/me/progress/${dateId}`,
    headers: {
      ...(await headersFor(playback, viewer, options)),
      'content-type': 'application/json',
    },
    payload: { positionSec, deviceId: viewer.deviceId, ...options.body },
  });
}

export async function batchCall(
  playback: Playback,
  viewer: Viewer,
  dateIds: readonly string[],
  options: RecordOptions = {},
) {
  return playback.app.inject({
    method: 'POST',
    url: '/v1/viewer-progress/batch',
    headers: {
      ...(await headersFor(playback, viewer, options)),
      'content-type': 'application/json',
    },
    payload: { profileId: viewer.profileId, dateIds, ...options.body },
  });
}

export interface PointBody {
  readonly positionSec?: number;
  readonly version?: number;
}

export function pointOf(response: { statusCode: number; body: string }): PointBody {
  if (response.statusCode !== 200) {
    throw new Error(`expected a point, got ${String(response.statusCode)}: ${response.body}`);
  }
  return (JSON.parse(response.body) as { data: PointBody }).data;
}

export interface ProgressBody {
  readonly positionSec: number;
  readonly writtenAt: string;
  readonly completed: boolean;
  readonly version: number;
}

export function tableOf(response: {
  statusCode: number;
  body: string;
}): Record<string, ProgressBody> {
  if (response.statusCode !== 200) {
    throw new Error(`expected a table, got ${String(response.statusCode)}: ${response.body}`);
  }
  return (JSON.parse(response.body) as { data: Record<string, ProgressBody> }).data;
}

export async function storedPoint(
  playback: Playback,
  ownerId: string,
  dateId: string,
): Promise<{ position_sec: number; version: string; device_id: string } | undefined> {
  const [row] = await playback.dataSource.query<
    { position_sec: number; version: string; device_id: string }[]
  >(
    `SELECT position_sec, version, device_id FROM resume_point WHERE owner_id = $1 AND date_id = $2`,
    [ownerId, dateId],
  );
  return row;
}
