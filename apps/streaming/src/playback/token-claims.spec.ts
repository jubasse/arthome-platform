import { describe, expect, it } from 'vitest';

import {
  DrmSystem,
  EdgeRenewalMode,
  PlaybackProtocol,
  QualityCap,
} from '@arthome/contracts/streaming';
import {
  PLAYBACK_RENEWAL_INTERVAL_SECONDS,
  PLAYBACK_TOKEN_LIFETIME_SECONDS,
  PlaybackSessionState,
  Surface,
  WatchScope,
  plusSeconds,
} from '@arthome/core';

import { activeScreensOf, type PlaybackSession } from './playback-sessions.js';
import {
  newSessionScope,
  newTokenId,
  playbackClaimsOf,
  renewAfterSecondsOf,
  tokenExpiresAt,
} from './token-claims.js';

const NOW = '2026-12-12T19:30:00.000Z';

const SUBJECT = {
  profileId: '01a0f600-0000-7000-8000-000000000001',
  deviceId: '01a0f601-0000-7000-8000-000000000001',
  dateId: '01a0f602-0000-7000-8000-000000000001',
  sessionId: '01a0f603-0000-7000-8000-000000000001',
  qualityCap: QualityCap.FHD,
  scope: WatchScope.FULL,
} as const;

describe('playbackClaimsOf', () => {
  it('names the profile, the device, the date, the session, the cap, the scope and the jti', () => {
    expect(playbackClaimsOf(SUBJECT, 'jti-1')).toEqual({
      sub: SUBJECT.profileId,
      did: SUBJECT.deviceId,
      dat: SUBJECT.dateId,
      sid: SUBJECT.sessionId,
      qmax: QualityCap.FHD,
      scope: WatchScope.FULL,
      jti: 'jti-1',
    });
  });

  it('takes a new jti at every issue and a random scope per session', () => {
    expect(newTokenId()).not.toBe(newTokenId());
    const scope = newSessionScope();
    expect(scope).toMatch(/^[\w-]{22}$/);
    expect(scope).not.toBe(newSessionScope());
  });
});

describe('tokenExpiresAt', () => {
  it("lives core's lifetime on a full scope", () => {
    expect(tokenExpiresAt(WatchScope.FULL, NOW, null)).toBe(
      plusSeconds(NOW, PLAYBACK_TOKEN_LIFETIME_SECONDS),
    );
  });

  it("never outlives the meter's cover on a preview, and is never issued without one", () => {
    const cover = plusSeconds(NOW, 30);
    expect(tokenExpiresAt(WatchScope.PREVIEW, NOW, cover)).toBe(cover);
    expect(() => tokenExpiresAt(WatchScope.PREVIEW, NOW, null)).toThrow();
  });

  it("never outlives core's lifetime on a preview whose cover reaches further", () => {
    const cover = plusSeconds(NOW, PLAYBACK_TOKEN_LIFETIME_SECONDS + 600);
    expect(tokenExpiresAt(WatchScope.PREVIEW, NOW, cover)).toBe(
      plusSeconds(NOW, PLAYBACK_TOKEN_LIFETIME_SECONDS),
    );
  });

  it("renews at core's interval, and a preview before its budget runs out", () => {
    expect(renewAfterSecondsOf(WatchScope.FULL, 0)).toBe(PLAYBACK_RENEWAL_INTERVAL_SECONDS);
    expect(renewAfterSecondsOf(WatchScope.PREVIEW, 20)).toBe(20);
  });
});

describe('a refusal listing the screens', () => {
  it('carries no token, no token id and no signed scope', () => {
    const session: PlaybackSession = {
      id: SUBJECT.sessionId,
      accountId: '01a0f604-0000-7000-8000-000000000001',
      profileId: SUBJECT.profileId,
      deviceId: SUBJECT.deviceId,
      dateId: SUBJECT.dateId,
      state: PlaybackSessionState.ACTIVE,
      revokeReason: null,
      scope: WatchScope.FULL,
      sessionScope: 'the-signed-scope',
      protocol: PlaybackProtocol.HLS,
      drmSystem: DrmSystem.WIDEVINE,
      qualityCap: QualityCap.FHD,
      edgeRenewalMode: EdgeRenewalMode.QUERY_TOKEN,
      surface: Surface.STOREFRONT_TV,
      tokenId: 'the-token-id',
      tokenExpiresAt: plusSeconds(NOW, 120),
      leaseExpiresAt: plusSeconds(NOW, 90),
      openedAt: NOW,
      lastRenewedAt: NOW,
    };
    const listed = activeScreensOf([session], 'another-device');
    expect(listed).toEqual([
      {
        sessionId: SUBJECT.sessionId,
        deviceId: SUBJECT.deviceId,
        isCurrentDevice: false,
        deviceLabel: Surface.STOREFRONT_TV,
        city: null,
        openedAt: NOW,
      },
    ]);
    const serialised = JSON.stringify(listed);
    expect(serialised).not.toContain('the-token-id');
    expect(serialised).not.toContain('the-signed-scope');
  });
});
