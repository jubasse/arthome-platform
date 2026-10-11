import { readPlaybackSigningKey } from '@arthome-platform/config';
import { startMediaStack, type StartedMediaStack } from '@arthome-platform/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SystemClock } from '@arthome/core';

import { startMediaServerStandIn, type MediaServerStandIn } from './media-server-stand-in.js';
import { getPath, livePathOf } from './mediamtx-api.js';
import { readMediaMtxEnv } from './mediamtx-env.js';
import { MediaMtxHttp } from './mediamtx-http.js';
import { MediaMtxStreamingProvider } from './mediamtx-streaming-provider.js';
import { RecordingNotFound } from '../media-ports.js';

const STARTUP_MS = 240_000;
const CASE_MS = 90_000;
const STREAM_PATH = 'recordedFeedS1';
const KEY = 'key-recorded-s1';
const RECORDED_MS = 10_000;

let stack: StartedMediaStack;
let standIn: MediaServerStandIn;
let provider: MediaMtxStreamingProvider;
let originApi: MediaMtxHttp;

beforeAll(async () => {
  standIn = await startMediaServerStandIn({
    authorize: ({ presentedKey }) =>
      Promise.resolve(
        presentedKey === KEY ? { accepted: true } : { accepted: false, reason: 'unknown_key' },
      ),
  });
  stack = await startMediaStack({ authorizeUrl: standIn.authorizeUrl });
  const env = readMediaMtxEnv(stack.providerEnv);
  originApi = new MediaMtxHttp('the origin', env.originApiUrl);
  provider = new MediaMtxStreamingProvider({
    env,
    signingKey: readPlaybackSigningKey({ NODE_ENV: 'test' }),
    clock: new SystemClock(),
  });
  await stack.startEncoder({ protocol: 'srt', streamPath: STREAM_PATH, key: KEY });
  await vi.waitFor(
    async () => {
      expect((await getPath(originApi, 'test read', livePathOf(STREAM_PATH)))?.online).toBe(true);
    },
    { timeout: 30_000, interval: 500 },
  );
}, STARTUP_MS);

afterAll(async () => {
  await stack.stop();
  await standIn.close();
});

describe('recording at the origin', () => {
  it(
    'records the master stream from start to stop, then deletes it',
    async () => {
      const before = await getPath(originApi, 'test read', livePathOf(STREAM_PATH));
      const ref = await provider.start(STREAM_PATH);
      await expect(provider.status(ref)).resolves.toEqual({ ready: false, durationSec: null });

      await new Promise((resolve) => setTimeout(resolve, RECORDED_MS));
      await provider.stop(ref);
      const status = await provider.status(ref);

      expect(status.ready).toBe(true);
      expect(Math.abs((status.durationSec ?? 0) - RECORDED_MS / 1_000)).toBeLessThanOrEqual(2);
      const after = await getPath(originApi, 'test read', livePathOf(STREAM_PATH));
      expect(after?.source?.id).toBe(before?.source?.id);

      await provider.delete(ref);
      const recordings = await originApi.json<{ segments: unknown[] }>({
        operation: 'test read',
        path: `/v3/recordings/get/${livePathOf(STREAM_PATH)}`,
      });
      expect(recordings?.segments ?? []).toEqual([]);
      await expect(provider.status(ref)).rejects.toBeInstanceOf(RecordingNotFound);
      await expect(provider.delete(ref)).resolves.toBeUndefined();
    },
    CASE_MS,
  );
});
