import { readPlaybackSigningKey } from '@arthome-platform/config';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';

import { EdgeRenewalMode, QualityCap } from '@arthome/contracts/streaming';
import { FixedClock, WatchScope, plusSeconds, toEpochMs } from '@arthome/core';

import { MEDIAMTX_SPEC_ENV } from './mediamtx-env-fixtures.js';
import { readMediaMtxEnv } from './mediamtx-env.js';
import { MediaMtxStreamingProvider } from './mediamtx-streaming-provider.js';
import { PlaybackSigningUnavailable, type PlaybackGrant } from '../media-ports.js';

const NOW = '2026-10-11T19:00:00.000Z';
const DATE_ID = '01a0e700-0000-7000-8000-0000000000a1';
const signingKey = readPlaybackSigningKey({ NODE_ENV: 'test' });
const provider = new MediaMtxStreamingProvider({
  env: readMediaMtxEnv(MEDIAMTX_SPEC_ENV),
  signingKey,
  clock: new FixedClock(NOW),
});
const { d: _private, ...publicHalf } = signingKey.privateJwk;
const edgeKeys = createLocalJWKSet({
  keys: [{ ...publicHalf, kid: signingKey.keyId, alg: 'ES256' }],
});

function grant(overrides: Partial<PlaybackGrant> = {}): PlaybackGrant {
  return {
    dateId: DATE_ID,
    streamPath: 'k7Qe2pLx9vWm',
    sessionScope: '01a0e700-0000-7000-8000-0000000000b1',
    claims: {
      sub: '01a0e700-0000-7000-8000-0000000000d1',
      did: DATE_ID,
      dat: '01a0e700-0000-7000-8000-0000000000e1',
      sid: '01a0e700-0000-7000-8000-0000000000f1',
      qmax: QualityCap.FHD,
      scope: WatchScope.FULL,
      jti: '01a0e700-0000-7000-8000-000000000101',
    },
    expiresAt: plusSeconds(NOW, 120),
    mechanism: EdgeRenewalMode.QUERY_TOKEN,
    ...overrides,
  };
}

describe('MediaMTX playback', () => {
  it('declares what Envoy does: a query token checked on every request, no cookie', () => {
    expect(provider.playbackCapabilities).toMatchObject({
      supportsSignedCookies: false,
      supportsQueryTokenRenewal: true,
      checksEveryRequest: true,
    });
  });

  it('refuses to sign by cookie rather than serve unsigned', async () => {
    await expect(
      provider.sign(grant({ mechanism: EdgeRenewalMode.SIGNED_COOKIE })),
    ).rejects.toBeInstanceOf(PlaybackSigningUnavailable);
  });

  it('signs PS3 claims bound to the date prefix, for the edge audience, until expiresAt', async () => {
    const signed = await provider.sign(grant());
    const token = signed.queryToken ?? '';
    const { payload } = await jwtVerify(token, edgeKeys, {
      algorithms: ['ES256'],
      audience: 'arthome.cdn',
      currentDate: new Date(NOW),
    });

    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'ES256', kid: signingKey.keyId });
    expect(payload).toMatchObject({ ...grant().claims, prefix: `/watch/${DATE_ID}/` });
    expect(payload.exp).toBe(toEpochMs(plusSeconds(NOW, 120)) / 1_000);
    expect(signed.cookies).toEqual([]);
    expect(signed.keyId).toBe(signingKey.keyId);
  });

  it('answers a manifest URL on Envoy, the same across renewals, with no token in it', async () => {
    const first = await provider.sign(grant());
    const renewed = await provider.sign(grant({ expiresAt: plusSeconds(NOW, 240) }));

    expect(first.manifestUrl).toBe(`http://127.0.0.1:58888/watch/${DATE_ID}/index.m3u8`);
    expect(renewed.manifestUrl).toBe(first.manifestUrl);
    expect(renewed.queryToken).not.toBe(first.queryToken);
  });

  it('refuses a date id that could climb out of its prefix', async () => {
    await expect(provider.sign(grant({ dateId: '../other' }))).rejects.toThrow(/URL-safe/);
  });
});
