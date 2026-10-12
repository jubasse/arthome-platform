import { readPlaybackSigningKey } from '@arthome-platform/config';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';

import { EdgeRenewalMode, QualityCap } from '@arthome/contracts/streaming';
import { FixedClock, WatchScope, plusSeconds, toEpochMs } from '@arthome/core';

import { MEDIAMTX_SPEC_ENV } from './mediamtx-env-fixtures.js';
import { readMediaMtxEnv } from './mediamtx-env.js';
import { MediaMtxStreamingProvider } from './mediamtx-streaming-provider.js';
import { PLAYBACK_COOKIE, type PlaybackGrant } from '../media-ports.js';

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
  it('declares what Envoy does: a token checked on every request, by cookie or query', () => {
    expect(provider.playbackCapabilities).toMatchObject({
      supportsSignedCookies: true,
      supportsQueryTokenRenewal: true,
      checksEveryRequest: true,
    });
  });

  it("signs the cookie on the date prefix with the query token's claims", async () => {
    const byQuery = await provider.sign(grant());
    const byCookie = await provider.sign(grant({ mechanism: EdgeRenewalMode.SIGNED_COOKIE }));
    const [cookie] = byCookie.cookies;
    const claimsOf = async (token: string) =>
      (
        await jwtVerify(token, edgeKeys, {
          algorithms: ['ES256'],
          audience: 'arthome.cdn',
          currentDate: new Date(NOW),
        })
      ).payload;

    expect(byCookie.cookies).toHaveLength(1);
    expect(cookie).toMatchObject({
      name: PLAYBACK_COOKIE,
      path: `/watch/${DATE_ID}/`,
      expiresAt: plusSeconds(NOW, 120),
    });
    expect(await claimsOf(cookie?.value ?? '')).toEqual(await claimsOf(byQuery.queryToken ?? ''));
  });

  it('answers no query token by cookie', async () => {
    const signed = await provider.sign(grant({ mechanism: EdgeRenewalMode.SIGNED_COOKIE }));

    expect(signed.queryToken).toBeNull();
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

    expect(first.manifestUrl).toBe(`http://localhost:58888/watch/${DATE_ID}/index.m3u8`);
    expect(renewed.manifestUrl).toBe(first.manifestUrl);
    expect(renewed.queryToken).not.toBe(first.queryToken);
  });

  it('answers the same manifest URL by cookie as by query', async () => {
    const byCookie = await provider.sign(grant({ mechanism: EdgeRenewalMode.SIGNED_COOKIE }));

    expect(byCookie.manifestUrl).toBe((await provider.sign(grant())).manifestUrl);
  });

  it('refuses a date id that could climb out of its prefix', async () => {
    await expect(provider.sign(grant({ dateId: '../other' }))).rejects.toThrow(/URL-safe/);
  });
});
