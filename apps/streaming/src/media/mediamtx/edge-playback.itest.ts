import { request } from 'node:http';

import { readPlaybackSigningKey } from '@arthome-platform/config';
import { startMediaStack, type StartedMediaStack } from '@arthome-platform/testing';
import { SignJWT, importJWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { EdgeRenewalMode, QualityCap } from '@arthome/contracts/streaming';
import { SystemClock, WatchScope, fromEpochMs, type Instant } from '@arthome/core';

import { startMediaServerStandIn, type MediaServerStandIn } from './media-server-stand-in.js';
import { readMediaMtxEnv } from './mediamtx-env.js';
import { MediaMtxStreamingProvider } from './mediamtx-streaming-provider.js';
import type { PlaybackGrant } from '../media-ports.js';

const STARTUP_MS = 240_000;
const CASE_MS = 90_000;
const STREAM_PATH = 'edgeFeedW1';
const KEY = 'key-edge-w1';
const DATE_A = '01a0e700-0000-7000-8000-0000000000a1';
const DATE_B = '01a0e700-0000-7000-8000-0000000000b2';
const signingKey = readPlaybackSigningKey({ NODE_ENV: 'test' });

let stack: StartedMediaStack;
let standIn: MediaServerStandIn;
let provider: MediaMtxStreamingProvider;
let edge: URL;

function inSeconds(seconds: number): Instant {
  return fromEpochMs(Date.now() + seconds * 1_000);
}

function grant(dateId: string, expiresAt: Instant): PlaybackGrant {
  return {
    dateId,
    streamPath: STREAM_PATH,
    sessionScope: '01a0e700-0000-7000-8000-0000000000c1',
    claims: {
      sub: '01a0e700-0000-7000-8000-0000000000d1',
      did: dateId,
      dat: '01a0e700-0000-7000-8000-0000000000e1',
      sid: '01a0e700-0000-7000-8000-0000000000f1',
      qmax: QualityCap.FHD,
      scope: WatchScope.FULL,
      jti: '01a0e700-0000-7000-8000-000000000101',
    },
    expiresAt,
    mechanism: EdgeRenewalMode.QUERY_TOKEN,
  };
}

async function tokenFor(dateId: string, expiresAt: Instant = inSeconds(120)): Promise<string> {
  return (await provider.sign(grant(dateId, expiresAt))).queryToken ?? '';
}

/** The path sent as written: `fetch` would resolve `..` before Envoy sees it. */
function get(path: string, token?: string): Promise<{ status: number; body: string }> {
  const target = token === undefined ? path : `${path}?token=${token}`;
  return new Promise((resolve, reject) => {
    request({ host: edge.hostname, port: edge.port, path: target }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
      });
    })
      .on('error', reject)
      .end();
  });
}

interface Playlist {
  readonly multivariant: string;
  readonly media: string;
  readonly segment: string;
  readonly part: string;
}

/** The newest segment and part of date A's media playlist, as paths under its prefix. */
async function playlistOfA(): Promise<Playlist> {
  const token = await tokenFor(DATE_A);
  const prefix = `/watch/${DATE_A}/`;
  const multivariant = await get(`${prefix}index.m3u8`, token);
  const mediaUri = multivariant.body.split('\n').find((line) => line.endsWith('.m3u8')) ?? '';
  const media = await get(`${prefix}${mediaUri}`, token);
  const lines = media.body.split('\n');
  const segment = lines.filter((line) => line !== '' && !line.startsWith('#')).at(-1) ?? '';
  const part =
    /URI="([^"]+)"/.exec(
      lines.filter((line) => line.startsWith('#EXT-X-PART:')).at(-1) ?? '',
    )?.[1] ?? '';
  return {
    multivariant: multivariant.body,
    media: media.body,
    segment: `${prefix}${segment}`,
    part: `${prefix}${part}`,
  };
}

beforeAll(async () => {
  standIn = await startMediaServerStandIn({
    authorize: ({ streamPath, presentedKey }) =>
      Promise.resolve(
        streamPath === STREAM_PATH && presentedKey === KEY
          ? { accepted: true }
          : { accepted: false, reason: 'unknown_key' },
      ),
  });
  stack = await startMediaStack({ authorizeUrl: standIn.authorizeUrl });
  edge = new URL(stack.playbackEdgeUrl);
  provider = new MediaMtxStreamingProvider({
    env: readMediaMtxEnv(stack.providerEnv),
    signingKey,
    clock: new SystemClock(),
  });
  provider.attachIngestHooks({
    authorizer: { authorize: () => Promise.reject(new Error('the origin asks MX1, not this')) },
    listener: {
      publisherOnline: () => Promise.resolve(),
      publisherOffline: () => Promise.resolve(),
      workerFailed: () => Promise.resolve(),
    },
  });
  await stack.startEncoder({ protocol: 'whip', streamPath: STREAM_PATH, key: KEY });
  await tokenFor(DATE_B);
  await vi.waitFor(
    async () => {
      const { segment, part } = await playlistOfA();
      expect(segment).toMatch(/\.mp4$/);
      expect(part).toMatch(/\.mp4$/);
    },
    { timeout: 60_000, interval: 1_000 },
  );
}, STARTUP_MS);

afterAll(async () => {
  await provider.beforeApplicationShutdown();
  await stack.stop();
  await standIn.close();
});

describe('playback through Envoy', () => {
  it('serves LL-HLS on a valid token, AAC for a WHIP feed', async () => {
    const { multivariant, media, segment, part } = await playlistOfA();
    const token = await tokenFor(DATE_A);

    expect(multivariant).toMatch(/CODECS="avc1\.[0-9a-f]+,mp4a\.40\.2"/);
    expect(media).toContain('#EXT-X-PART:');
    expect((await get(segment, token)).status).toBe(200);
    expect((await get(part, token)).status).toBe(200);
  });

  it(
    'refuses a segment and a part without a valid token for their date',
    async () => {
      const { segment, part } = await playlistOfA();
      const key = await importJWK({ ...signingKey.privateJwk }, 'ES256');
      const otherAudience = await new SignJWT({ prefix: `/watch/${DATE_A}/` })
        .setProtectedHeader({ alg: 'ES256', kid: signingKey.keyId })
        .setAudience('arthome.api')
        .setExpirationTime('2m')
        .sign(key);
      const expired = await tokenFor(DATE_A, inSeconds(-60));
      const dateB = await tokenFor(DATE_B);

      for (const path of [segment, part]) {
        const name = path.slice(`/watch/${DATE_A}/`.length);
        expect((await get(path)).status, `${name} without a token`).toBe(401);
        expect((await get(path, expired)).status, `${name} expired`).toBe(401);
        expect((await get(path, otherAudience)).status, `${name} other audience`).toBe(401);
        expect((await get(path, dateB)).status, `${name} another date`).toBe(401);
        expect((await get(`/watch/${DATE_B}/../${DATE_A}/${name}`, dateB)).status).toBe(401);
        expect((await get(`/watch/${DATE_B}/%2e%2e/${DATE_A}/${name}`, dateB)).status).toBe(401);
        // `path_with_escaped_slashes_action: REJECT_REQUEST`: refused before any filter.
        expect((await get(`/watch/${DATE_B}/..%2F${DATE_A}/${name}`, dateB)).status).toBe(400);
      }
    },
    CASE_MS,
  );

  it(
    'refuses a token accepted while valid once it is past its exp',
    async () => {
      const shortLived = await tokenFor(DATE_A, inSeconds(4));
      const { segment } = await playlistOfA();
      expect((await get(segment, shortLived)).status).toBe(200);

      // `clock_skew_seconds: 5` (infra/envoy/edge.yaml), then a second of margin.
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      const fresh = await playlistOfA();

      expect((await get(fresh.segment, shortLived)).status).toBe(401);
      expect((await get(fresh.part, shortLived)).status).toBe(401);
    },
    CASE_MS,
  );

  it('leaves the edge HLS port unreachable from the host', () => {
    expect(stack.edgeHlsPortMapped).toBe(false);
  });
});
