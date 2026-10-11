import { describe, expect, it } from 'vitest';

import {
  MediaServerRefusal,
  attemptOf,
  type MediaServerAuthorization,
} from './media-server-attempt.js';
import { IngestProtocol } from '../media/media-ports.js';

const PATH = 'q8C2v6ZkRxa1Lr0bT3n9Yw';
const KEY = 'the-run-key';

function request(overrides: Partial<MediaServerAuthorization> = {}): MediaServerAuthorization {
  return {
    action: 'publish',
    path: `live/${PATH}`,
    protocol: 'srt',
    ip: '172.18.0.4',
    user: 'any',
    password: KEY,
    token: '',
    query: '',
    id: null,
    ...overrides,
  };
}

describe('attemptOf, a publish', () => {
  it.each([
    ['webrtc', IngestProtocol.WHIP],
    ['srt', IngestProtocol.SRT],
  ])('maps %s to %s', (protocol, ingest) => {
    expect(attemptOf(request({ protocol }))).toEqual({
      kind: 'publish',
      attempt: { streamPath: PATH, presentedKey: KEY, protocol: ingest },
    });
  });

  it('takes the token over the password, and the password when the token is empty or absent', () => {
    const keyOf = (overrides: Partial<MediaServerAuthorization>) => {
      const decided = attemptOf(request(overrides));
      return decided.kind === 'publish' ? decided.attempt.presentedKey : decided.reason;
    };

    expect(keyOf({ protocol: 'webrtc', token: 'bearer-key', password: 'other' })).toBe(
      'bearer-key',
    );
    expect(keyOf({ token: '' })).toBe(KEY);
    expect(keyOf({ token: undefined })).toBe(KEY);
  });
});

describe('attemptOf, refused', () => {
  it.each<[string, Partial<MediaServerAuthorization>, MediaServerRefusal]>([
    ['rtmp', { protocol: 'rtmp' }, MediaServerRefusal.NO_INGEST_PROTOCOL],
    ['rtsp', { protocol: 'rtsp' }, MediaServerRefusal.NO_INGEST_PROTOCOL],
    ['hls', { protocol: 'hls' }, MediaServerRefusal.NO_INGEST_PROTOCOL],
    ['an unknown protocol', { protocol: 'moq' }, MediaServerRefusal.NO_INGEST_PROTOCOL],
    [
      'a protocol named after a prototype key',
      { protocol: 'toString' },
      MediaServerRefusal.NO_INGEST_PROTOCOL,
    ],
    ['a nested path', { path: `live/${PATH}/b` }, MediaServerRefusal.NOT_A_LIVE_PATH],
    ['live/a/b', { path: 'live/a/b' }, MediaServerRefusal.NOT_A_LIVE_PATH],
    ['a path outside live/', { path: 'hls/x' }, MediaServerRefusal.NOT_A_LIVE_PATH],
    ['live/ alone', { path: 'live/' }, MediaServerRefusal.NOT_A_LIVE_PATH],
    ['a bare stream path', { path: PATH }, MediaServerRefusal.NOT_A_LIVE_PATH],
    ['both credentials empty', { password: '', token: '' }, MediaServerRefusal.NO_KEY],
    [
      'both credentials absent',
      { password: undefined, token: undefined },
      MediaServerRefusal.NO_KEY,
    ],
    ['a read', { action: 'read' }, MediaServerRefusal.NOT_A_PUBLISH],
    ['a playback', { action: 'playback' }, MediaServerRefusal.NOT_A_PUBLISH],
    ['an api call', { action: 'api' }, MediaServerRefusal.NOT_A_PUBLISH],
    ['metrics', { action: 'metrics' }, MediaServerRefusal.NOT_A_PUBLISH],
    ['pprof', { action: 'pprof' }, MediaServerRefusal.NOT_A_PUBLISH],
    ['an unknown action, kept raw', { action: 'Publish' }, MediaServerRefusal.NOT_A_PUBLISH],
  ])('refuses %s', (_case, overrides, reason) => {
    expect(attemptOf(request(overrides))).toEqual({ kind: 'refusal', reason });
  });
});
