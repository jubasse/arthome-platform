import { readPlaybackSigningKey } from '@arthome-platform/config';
import { startMediaStack, type StartedMediaStack } from '@arthome-platform/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SystemClock } from '@arthome/core';

import { startMediaServerStandIn, type MediaServerStandIn } from './media-server-stand-in.js';
import { getPath, livePathOf } from './mediamtx-api.js';
import { readMediaMtxEnv } from './mediamtx-env.js';
import { MediaMtxHttp } from './mediamtx-http.js';
import { MediaMtxStreamingProvider } from './mediamtx-streaming-provider.js';
import {
  IngestProtocol,
  type IngestDecision,
  type PublisherOffline,
  type PublisherOnline,
} from '../media-ports.js';

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;
const KEYS = new Map([
  ['whipFeedA1', 'key-whip-a1'],
  ['whipFeedB2', 'key-whip-b2'],
  ['srtFeedC3', 'key-srt-c3'],
]);

let stack: StartedMediaStack;
let standIn: MediaServerStandIn;
let provider: MediaMtxStreamingProvider;
let originApi: MediaMtxHttp;
const online: PublisherOnline[] = [];
const offline: PublisherOffline[] = [];

beforeAll(async () => {
  standIn = await startMediaServerStandIn({
    authorize: ({ streamPath, presentedKey }): Promise<IngestDecision> =>
      Promise.resolve(
        KEYS.get(streamPath) === presentedKey
          ? { accepted: true }
          : { accepted: false, reason: 'unknown_key' },
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
  provider.attachIngestHooks({
    authorizer: { authorize: () => Promise.reject(new Error('the origin asks MX1, not this')) },
    listener: {
      publisherOnline: (event) => {
        online.push(event);
        return Promise.resolve();
      },
      publisherOffline: (event) => {
        offline.push(event);
        return Promise.resolve();
      },
      workerFailed: () => Promise.resolve(),
    },
  });
}, STARTUP_MS);

afterAll(async () => {
  await provider.beforeApplicationShutdown();
  await stack.stop();
  await standIn.close();
});

function onlineOn(streamPath: string): PublisherOnline[] {
  return online.filter((event) => event.streamPath === streamPath);
}

describe('ingest on MediaMTX', () => {
  it(
    'puts a WHIP feed online with its key, reported once with its protocol',
    async () => {
      const encoder = await stack.startEncoder({
        protocol: 'whip',
        streamPath: 'whipFeedA1',
        key: 'key-whip-a1',
      });
      await vi.waitFor(() => expect(onlineOn('whipFeedA1')).toHaveLength(1), {
        timeout: 30_000,
        interval: 250,
      });

      expect(onlineOn('whipFeedA1')[0]?.protocol).toBe(IngestProtocol.WHIP);
      await encoder.stop();
    },
    CASE_MS,
  );

  it(
    'never puts a feed online with a wrong key',
    async () => {
      const encoder = await stack.startEncoder({
        protocol: 'whip',
        streamPath: 'whipFeedB2',
        key: 'not-the-key',
      });
      await vi.waitFor(() => expect(standIn.decisions).toContain(403), { timeout: 30_000 });
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      expect(onlineOn('whipFeedB2')).toEqual([]);
      expect(await getPath(originApi, 'test read', livePathOf('whipFeedB2'))).toBeNull();
      await encoder.stop();
    },
    CASE_MS,
  );

  it(
    'refuses a second publisher on a live path, the first kept; disconnect brings it offline',
    async () => {
      const first = await stack.startEncoder({
        protocol: 'srt',
        streamPath: 'srtFeedC3',
        key: 'key-srt-c3',
      });
      await vi.waitFor(() => expect(onlineOn('srtFeedC3')).toHaveLength(1), {
        timeout: 30_000,
        interval: 250,
      });
      const before = await getPath(originApi, 'test read', livePathOf('srtFeedC3'));
      const second = await stack.startEncoder({
        protocol: 'srt',
        streamPath: 'srtFeedC3',
        key: 'key-srt-c3',
      });
      await new Promise((resolve) => setTimeout(resolve, 5_000));

      const during = await getPath(originApi, 'test read', livePathOf('srtFeedC3'));
      expect(during?.source?.id).toBe(before?.source?.id);
      expect(onlineOn('srtFeedC3')).toHaveLength(1);
      expect(onlineOn('srtFeedC3')[0]?.protocol).toBe(IngestProtocol.SRT);

      await second.stop();
      await provider.disconnect('srtFeedC3');
      await vi.waitFor(
        () => expect(offline.map(({ streamPath }) => streamPath)).toContain('srtFeedC3'),
        { timeout: 10_000, interval: 250 },
      );
      await first.stop();
    },
    CASE_MS,
  );
});
