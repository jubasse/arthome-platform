import { describe, expect, it } from 'vitest';

import {
  DrmSystem,
  EdgeRenewalMode,
  PlaybackProtocol,
  QualityCap,
} from '@arthome/contracts/streaming';
import { Surface } from '@arthome/core';

import { playbackFormatFor, qualityCapFor, setCookieHeadersOf } from './playback-format.js';
import { FAKE_PLAYBACK_CAPABILITIES } from '../media/fake-streaming-provider.js';
import type { PlaybackCapabilities } from '../media/media-ports.js';

const WITH_DRM: PlaybackCapabilities = {
  ...FAKE_PLAYBACK_CAPABILITIES,
  protocols: [PlaybackProtocol.HLS, PlaybackProtocol.DASH],
  drmSystems: [DrmSystem.FAIRPLAY, DrmSystem.WIDEVINE],
};

describe('qualityCapFor', () => {
  it('caps by the height the device declares', () => {
    expect(qualityCapFor(480)).toBe(QualityCap.SD);
    expect(qualityCapFor(720)).toBe(QualityCap.HD);
    expect(qualityCapFor(1079)).toBe(QualityCap.HD);
    expect(qualityCapFor(1080)).toBe(QualityCap.FHD);
    expect(qualityCapFor(2160)).toBe(QualityCap.UHD);
  });

  it('degrades to hd when the device declares nothing', () => {
    expect(qualityCapFor(undefined)).toBe(QualityCap.HD);
  });
});

describe('playbackFormatFor', () => {
  it('serves the fake without DRM, over HLS, whatever the device declares', () => {
    const format = playbackFormatFor(
      FAKE_PLAYBACK_CAPABILITIES,
      { drmSystems: [DrmSystem.WIDEVINE], maxHeightPx: 1080 },
      Surface.STOREFRONT_TV,
    );
    expect(format).toEqual({
      protocol: PlaybackProtocol.HLS,
      drmSystem: null,
      qualityCap: QualityCap.FHD,
      mechanism: EdgeRenewalMode.QUERY_TOKEN,
    });
  });

  it('chooses a DRM both declare, FairPlay on HLS and Widevine on DASH', () => {
    const tv = playbackFormatFor(
      WITH_DRM,
      { drmSystems: [DrmSystem.FAIRPLAY] },
      Surface.STOREFRONT_TV,
    );
    expect([tv.drmSystem, tv.protocol]).toEqual([DrmSystem.FAIRPLAY, PlaybackProtocol.HLS]);
    const stick = playbackFormatFor(
      WITH_DRM,
      { drmSystems: [DrmSystem.PLAYREADY, DrmSystem.WIDEVINE] },
      Surface.STOREFRONT_MOBILE,
    );
    expect([stick.drmSystem, stick.protocol]).toEqual([DrmSystem.WIDEVINE, PlaybackProtocol.DASH]);
  });

  it('signs the browser by cookie, and by query token when cookies are not offered', () => {
    expect(
      playbackFormatFor(FAKE_PLAYBACK_CAPABILITIES, undefined, Surface.STOREFRONT_WEB).mechanism,
    ).toBe(EdgeRenewalMode.SIGNED_COOKIE);
    const noCookies = { ...FAKE_PLAYBACK_CAPABILITIES, supportsSignedCookies: false };
    expect(playbackFormatFor(noCookies, undefined, Surface.STOREFRONT_WEB).mechanism).toBe(
      EdgeRenewalMode.QUERY_TOKEN,
    );
    expect(
      playbackFormatFor(FAKE_PLAYBACK_CAPABILITIES, undefined, Surface.STOREFRONT_MOBILE).mechanism,
    ).toBe(EdgeRenewalMode.QUERY_TOKEN);
  });
});

describe('setCookieHeadersOf', () => {
  it('sets each cookie on its prefix, expiring with the token, out of scripts', () => {
    expect(
      setCookieHeadersOf([
        {
          name: 'arthome_playback',
          value: 'signed',
          path: '/playback/d/s/',
          expiresAt: '2026-12-12T19:32:00.000Z',
        },
      ]),
    ).toEqual([
      'arthome_playback=signed; Path=/playback/d/s/; Expires=Sat, 12 Dec 2026 19:32:00 GMT; ' +
        'Secure; HttpOnly; SameSite=None',
    ]);
  });
});
