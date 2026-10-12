import { request, type IncomingHttpHeaders } from 'node:http';

import { readPlaybackSigningKey } from '@arthome-platform/config';
import {
  MEDIA_STACK_STOP_MS,
  startMediaStack,
  type StartedMediaStack,
} from '@arthome-platform/testing';
import { SignJWT, importJWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { EdgeRenewalMode, QualityCap } from '@arthome/contracts/streaming';
import { SystemClock, WatchScope, fromEpochMs, type Instant } from '@arthome/core';

import { readMediaMtxEnv } from './mediamtx-env.js';
import { MediaMtxStreamingProvider } from './mediamtx-streaming-provider.js';
import {
  startMediaServerStandIn,
  type MediaServerStandIn,
} from '../../itest/media-server-stand-in.js';
import { PLAYBACK_COOKIE, type PlaybackGrant } from '../media-ports.js';

const STARTUP_MS = 240_000;
const CASE_MS = 90_000;
const STREAM_PATH = 'edgeFeedW1';
const KEY = 'key-edge-w1';
const DATE_A = '01a0e700-0000-7000-8000-0000000000a1';
const DATE_B = '01a0e700-0000-7000-8000-0000000000b2';
// Not `edge.yaml`'s literal: the suite proves `startMediaStack` replaces it.
const STOREFRONT = 'http://localhost:3999';
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

type Source = 'query' | 'cookie';

interface Credentials {
  readonly query?: string;
  readonly cookie?: string;
  readonly origin?: string;
}

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function by(source: Source, token: string): Credentials {
  return source === 'query' ? { query: token } : { cookie: token };
}

/** The path sent as written: `fetch` would resolve `..` before Envoy sees it. */
function get(path: string, { query, cookie, origin }: Credentials = {}): Promise<Answer> {
  const target = query === undefined ? path : `${path}?token=${query}`;
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers.cookie = `${PLAYBACK_COOKIE}=${cookie}`;
  if (origin !== undefined) headers.origin = origin;
  return new Promise((resolve, reject) => {
    request({ host: edge.hostname, port: edge.port, path: target, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
        });
      });
    })
      .on('error', reject)
      .end();
  });
}

function corsOf({ headers }: Answer): readonly [unknown, unknown] {
  return [headers['access-control-allow-origin'], headers['access-control-allow-credentials']];
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
  const multivariant = await get(`${prefix}index.m3u8`, { query: token });
  const mediaUri = multivariant.body.split('\n').find((line) => line.endsWith('.m3u8')) ?? '';
  const media = await get(`${prefix}${mediaUri}`, { query: token });
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
  stack = await startMediaStack({
    authorizeUrl: standIn.authorizeUrl,
    storefrontOrigin: STOREFRONT,
  });
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
}, MEDIA_STACK_STOP_MS);

async function signedFor(prefix: string, audience = 'arthome.cdn'): Promise<string> {
  const key = await importJWK({ ...signingKey.privateJwk }, 'ES256');
  return new SignJWT({ prefix })
    .setProtectedHeader({ alg: 'ES256', kid: signingKey.keyId })
    .setAudience(audience)
    .setExpirationTime('2m')
    .sign(key);
}

describe('playback through Envoy', () => {
  it('serves LL-HLS on a valid token, AAC for a WHIP feed', async () => {
    const { multivariant, media, segment, part } = await playlistOfA();
    const token = await tokenFor(DATE_A);

    expect(multivariant).toMatch(/CODECS="avc1\.[0-9a-f]+,mp4a\.40\.2"/);
    expect(media).toContain('#EXT-X-PART:');
    expect((await get(segment, { query: token })).status).toBe(200);
    expect((await get(part, { query: token })).status).toBe(200);
  });

  it('serves LL-HLS on a valid cookie for its date', async () => {
    const { segment, part } = await playlistOfA();
    const token = await tokenFor(DATE_A);

    expect((await get(`/watch/${DATE_A}/index.m3u8`, { cookie: token })).body).toMatch(/^#EXTM3U/);
    expect((await get(segment, { cookie: token })).status).toBe(200);
    expect((await get(part, { cookie: token })).status).toBe(200);
  });

  it(
    'refuses by cookie as by query',
    async () => {
      const { segment, part } = await playlistOfA();
      const otherAudience = await signedFor(`/watch/${DATE_A}/`, 'arthome.api');
      const expired = await tokenFor(DATE_A, inSeconds(-60));
      const dateB = await tokenFor(DATE_B);

      for (const path of [segment, part]) {
        const name = path.slice(`/watch/${DATE_A}/`.length);
        expect((await get(path)).status, `${name} without a token`).toBe(401);
        for (const source of ['query', 'cookie'] as const) {
          const as = (token: string) => by(source, token);
          const label = `${name} by ${source}`;
          expect((await get(path, as(expired))).status, `${label}, expired`).toBe(401);
          expect((await get(path, as(otherAudience))).status, `${label}, other audience`).toBe(401);
          expect((await get(path, as(dateB))).status, `${label}, another date`).toBe(401);
          expect((await get(`/watch/${DATE_B}/../${DATE_A}/${name}`, as(dateB))).status).toBe(401);
          expect((await get(`/watch/${DATE_B}/%2e%2e/${DATE_A}/${name}`, as(dateB))).status).toBe(
            401,
          );
          // `path_with_escaped_slashes_action: REJECT_REQUEST`: refused before any filter.
          expect((await get(`/watch/${DATE_B}/..%2F${DATE_A}/${name}`, as(dateB))).status).toBe(
            400,
          );
        }
      }
    },
    CASE_MS,
  );

  it(
    'refuses a token whose prefix is not one date in the shape the API signs',
    async () => {
      const { segment } = await playlistOfA();

      for (const prefix of ['', '/', '/watch/', `/watch/${DATE_A}`]) {
        const token = await signedFor(prefix);
        expect((await get(segment, { query: token })).status, `"${prefix}"`).toBe(401);
        expect((await get(segment, { cookie: token })).status, `"${prefix}" by cookie`).toBe(401);
      }
      expect((await get(segment, { query: await signedFor(`/watch/${DATE_A}/`) })).status).toBe(
        200,
      );
    },
    CASE_MS,
  );

  it(
    'answers CORS with credentials to the storefront origin only',
    async () => {
      const { segment, part } = await playlistOfA();
      const token = await tokenFor(DATE_A);

      for (const path of [segment, part]) {
        const served = await get(path, { cookie: token, origin: STOREFRONT });
        const refused = await get(path, { origin: STOREFRONT });
        expect(served.status).toBe(200);
        expect(refused.status).toBe(401);
        expect(corsOf(served)).toEqual([STOREFRONT, 'true']);
        expect(corsOf(refused)).toEqual([STOREFRONT, 'true']);

        // `edge.yaml`'s own literal included: the suite's origin replaced it.
        for (const origin of ['http://localhost:3000', 'https://elsewhere.example']) {
          const other = await get(path, { cookie: token, origin });
          expect(other.status).toBe(200);
          expect(corsOf(other), origin).toEqual([undefined, undefined]);
          expect(corsOf(await get(path, { origin })), origin).toEqual([undefined, undefined]);
        }
      }
    },
    CASE_MS,
  );

  it(
    'serves a request carrying both sources only on a verified token bound to its path',
    async () => {
      const { segment, part } = await playlistOfA();
      const dateA = await tokenFor(DATE_A);
      const dateB = await tokenFor(DATE_B);
      const expired = await tokenFor(DATE_A, inSeconds(-60));

      for (const path of [segment, part]) {
        expect((await get(path, { cookie: dateA, query: dateA })).status).toBe(200);
        // Both must verify, and the query's claims bind the path (R0).
        expect((await get(path, { cookie: dateB, query: dateA })).status).toBe(200);
        expect((await get(path, { cookie: dateA, query: dateB })).status).toBe(401);
        expect((await get(path, { cookie: expired, query: dateA })).status).toBe(401);
        expect((await get(path, { cookie: dateA, query: expired })).status).toBe(401);
        expect((await get(path, { cookie: 'not.a.jwt', query: dateA })).status).toBe(401);
      }
    },
    CASE_MS,
  );

  it(
    'refuses a token accepted while valid once it is past its exp, by cookie as by query',
    async () => {
      const shortLived = await tokenFor(DATE_A, inSeconds(4));
      const { segment } = await playlistOfA();
      expect((await get(segment, { query: shortLived })).status).toBe(200);
      expect((await get(segment, { cookie: shortLived })).status).toBe(200);

      // `clock_skew_seconds: 5` (infra/envoy/edge.yaml), then a second of margin.
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      const fresh = await playlistOfA();

      for (const source of ['query', 'cookie'] as const) {
        expect((await get(fresh.segment, by(source, shortLived))).status, source).toBe(401);
        expect((await get(fresh.part, by(source, shortLived))).status, source).toBe(401);
      }
    },
    CASE_MS,
  );

  it('leaves the edge HLS port unreachable from the host', () => {
    expect(stack.edgeHlsPortMapped).toBe(false);
  });
});
