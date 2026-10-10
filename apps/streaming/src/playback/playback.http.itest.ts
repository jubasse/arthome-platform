import { randomUUID } from 'node:crypto';

import { guardDeclaredResponses } from '@arthome-platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EdgeRenewalMode, PlaybackProtocol, QualityCap } from '@arthome/contracts/streaming';
import { streamingServiceApi } from '@arthome/contracts/streaming-service-api';
import {
  ApiErrorCode,
  ChatMode,
  DisplayState,
  InternalTokenIssuer,
  PLAYBACK_LEASE_SECONDS,
  PLAYBACK_RENEWAL_INTERVAL_SECONDS,
  PLAYBACK_TOKEN_LIFETIME_SECONDS,
  RunState,
  Surface,
  WatchDenialReason,
  WatchScope,
  plusSeconds,
} from '@arthome/core';

import {
  CASE_MS,
  STARTUP_MS,
  errorOf,
  grantSeat,
  identityId,
  liveDate,
  newViewer,
  onAnotherDevice,
  openCall,
  releaseCall,
  renewCall,
  startPlayback,
  stopPlayback,
  ticketOf,
  type Playback,
  type Viewer,
} from '../itest/playback.js';
import { FAKE_PLAYBACK_CAPABILITIES } from '../media/fake-streaming-provider.js';

/**
 * The player's three routes through the module graph the API boots, over HTTP, every answer
 *   checked against `streamingServiceApi`'s declaration.
 */

const responses = guardDeclaredResponses(streamingServiceApi);

let playback: Playback;

beforeAll(async () => {
  playback = await startPlayback('streaming_playback_http_itest', { watch: responses });
}, STARTUP_MS);

afterAll(async () => {
  await stopPlayback(playback);
});

async function holderOnLiveDate(): Promise<{ viewer: Viewer; dateId: string }> {
  const viewer = newViewer();
  const dateId = await liveDate(playback);
  await grantSeat(playback, viewer.accountId, dateId);
  return { viewer, dateId };
}

describe('openPlayback', () => {
  it(
    'answers the whole screen to a holder, never stored, signed by query token on a television',
    async () => {
      const { viewer, dateId } = await holderOnLiveDate();
      const now = playback.clock.now();

      const opened = await openCall(playback, viewer, dateId);

      expect(opened.headers['cache-control']).toBe('no-store');
      const ticket = ticketOf(opened);
      expect(ticket).toMatchObject({
        resumedExistingSession: false,
        dateId,
        scope: WatchScope.FULL,
        previewSecondsLeft: null,
        protocol: PlaybackProtocol.HLS,
        drmSystem: null,
        qualityCap: QualityCap.FHD,
        edgeRenewalMode: EdgeRenewalMode.QUERY_TOKEN,
        signature: { cookieSet: false },
        expiresAt: plusSeconds(now, PLAYBACK_TOKEN_LIFETIME_SECONDS),
        renewAfterSec: PLAYBACK_RENEWAL_INTERVAL_SECONDS,
        leaseExpiresAt: plusSeconds(now, PLAYBACK_LEASE_SECONDS),
        resumePoint: null,
        chatMode: ChatMode.OFF,
        incident: null,
      });
      expect(ticket.signature.queryToken).toEqual(expect.any(String));
      expect(ticket.manifestUrl).not.toContain(ticket.signature.queryToken ?? '');
      expect(opened.headers['set-cookie']).toBeUndefined();
    },
    CASE_MS,
  );

  it(
    'sets the signed cookie on the browser, with no token in the body',
    async () => {
      const { viewer, dateId } = await holderOnLiveDate();

      const opened = await openCall(playback, viewer, dateId, { surface: Surface.STOREFRONT_WEB });

      const ticket = ticketOf(opened);
      expect(ticket.edgeRenewalMode).toBe(EdgeRenewalMode.SIGNED_COOKIE);
      expect(ticket.signature).toEqual({ queryToken: null, cookieSet: true });
      expect(String(opened.headers['set-cookie'])).toMatch(
        /^arthome_playback=[\w.-]+; Path=\/playback\/[\w-]+\/[\w-]+\/; Expires=.+; Secure; HttpOnly; SameSite=None$/,
      );
    },
    CASE_MS,
  );

  it(
    'refuses a replay before any read, and a date the projection does not hold',
    async () => {
      const viewer = newViewer();

      const replay = await openCall(playback, viewer, randomUUID(), {
        body: { kind: DisplayState.REPLAY },
      });
      expect(replay.statusCode).toBe(403);
      expect(errorOf(replay).code).toBe(WatchDenialReason.NO_REPLAY);

      const unknown = await openCall(playback, viewer, randomUUID());
      expect(unknown.statusCode).toBe(404);
      expect(errorOf(unknown).code).toBe(ApiErrorCode.NOT_FOUND);
    },
    CASE_MS,
  );

  it(
    'gives a non-holder no preview while the meter is not bound: the verdict, then nothing written',
    async () => {
      const viewer = newViewer();
      const dateId = await liveDate(playback);

      const refused = await openCall(playback, viewer, dateId);

      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused).code).toBe(WatchDenialReason.PREVIEW_EXHAUSTED);
      expect(
        await playback.dataSource.query('SELECT 1 FROM playback_session WHERE account_id = $1', [
          viewer.accountId,
        ]),
      ).toEqual([]);
    },
    CASE_MS,
  );

  it(
    'refuses a viewer out of territory, and a date whose live ended',
    async () => {
      const viewer = newViewer();
      const blackedOut = await liveDate(playback, { blackoutCountries: ['FR'] });
      await grantSeat(playback, viewer.accountId, blackedOut);
      const ended = await liveDate(playback, { runState: RunState.ENDED });
      await grantSeat(playback, viewer.accountId, ended);

      const outside = await openCall(playback, viewer, blackedOut);
      expect(errorOf(outside).code).toBe(WatchDenialReason.OUT_OF_TERRITORY);
      const over = await openCall(playback, viewer, ended);
      expect(errorOf(over).code).toBe(WatchDenialReason.LIVE_ENDED);
    },
    CASE_MS,
  );

  it(
    'refuses a missing country header and a deadline already past, before any work',
    async () => {
      const { viewer, dateId } = await holderOnLiveDate();

      const countryless = await openCall(playback, viewer, dateId, { country: null });
      expect(countryless.statusCode).toBe(400);
      expect(errorOf(countryless).code).toBe(ApiErrorCode.SCHEMA_INVALID);

      const past = new Date(playback.clock.nowMs() - 1_000).toISOString();
      const late = await openCall(playback, viewer, dateId, { deadline: past });
      expect(late.statusCode).toBe(504);
      expect(errorOf(late).code).toBe(ApiErrorCode.DEADLINE_EXCEEDED);
    },
    CASE_MS,
  );

  it(
    'answers the service 500 when the provider cannot sign the chosen way, and keeps no lease',
    async () => {
      const { viewer, dateId } = await holderOnLiveDate();
      Object.defineProperty(playback.fake, 'playbackCapabilities', {
        value: { ...FAKE_PLAYBACK_CAPABILITIES, supportsQueryTokenRenewal: false },
        configurable: true,
      });
      try {
        const unsigned = await openCall(playback, viewer, dateId);
        expect(unsigned.statusCode).toBe(500);
        expect(errorOf(unsigned).code).toBe(ApiErrorCode.INTERNAL);
        expect(unsigned.body).not.toContain('manifest');
      } finally {
        Object.defineProperty(playback.fake, 'playbackCapabilities', {
          value: FAKE_PLAYBACK_CAPABILITIES,
          configurable: true,
        });
      }
      expect(
        await playback.dataSource.query('SELECT 1 FROM playback_session WHERE account_id = $1', [
          viewer.accountId,
        ]),
      ).toEqual([]);
    },
    CASE_MS,
  );
});

describe('the caller', () => {
  it(
    'refuses a studio-issued token, a token with no user, no profile or no device',
    async () => {
      const { viewer, dateId } = await holderOnLiveDate();

      for (const options of [
        { issuer: InternalTokenIssuer.STUDIO_BFF },
        { token: { accountId: null } },
        { token: { profileId: null } },
        { token: { deviceId: null } },
      ]) {
        const refused = await openCall(playback, viewer, dateId, options);
        expect(refused.statusCode, JSON.stringify(options)).toBe(403);
        expect(errorOf(refused).code).toBe(ApiErrorCode.FORBIDDEN);
      }
    },
    CASE_MS,
  );

  it(
    "refuses a body naming a profile or a device that differs from the token's, 403",
    async () => {
      const { viewer, dateId } = await holderOnLiveDate();

      const otherProfile = await openCall(playback, viewer, dateId, {
        body: { profileId: randomUUID() },
      });
      expect(otherProfile.statusCode).toBe(403);
      expect(errorOf(otherProfile).code).toBe(ApiErrorCode.FORBIDDEN);

      const otherDevice = await openCall(playback, viewer, dateId, {
        body: { deviceId: randomUUID() },
      });
      expect(otherDevice.statusCode).toBe(403);
      expect(errorOf(otherDevice).code).toBe(ApiErrorCode.FORBIDDEN);
    },
    CASE_MS,
  );

  it(
    "answers another account's session 404, and a renewal from another device or profile 403",
    async () => {
      const { viewer, dateId } = await holderOnLiveDate();
      const { sessionId } = ticketOf(await openCall(playback, viewer, dateId));
      const stranger = newViewer();

      expect((await renewCall(playback, stranger, sessionId)).statusCode).toBe(404);
      expect((await releaseCall(playback, stranger, sessionId)).statusCode).toBe(404);

      const differs = await renewCall(playback, onAnotherDevice(viewer), sessionId);
      expect(differs.statusCode).toBe(403);
      expect(errorOf(differs).code).toBe(ApiErrorCode.FORBIDDEN);
      const otherProfile = await renewCall(
        playback,
        { ...viewer, profileId: identityId() },
        sessionId,
      );
      expect(otherProfile.statusCode).toBe(403);
      expect(errorOf(otherProfile).code).toBe(ApiErrorCode.FORBIDDEN);

      const userless = await releaseCall(playback, viewer, sessionId, {
        token: { accountId: null },
      });
      expect(userless.statusCode).toBe(403);
      expect(errorOf(userless).code).toBe(ApiErrorCode.FORBIDDEN);
    },
    CASE_MS,
  );
});

describe('renewPlaybackTicket and releasePlayback', () => {
  it(
    'renews without moving the manifest, then releases twice, and the released renewal is 404',
    async () => {
      const { viewer, dateId } = await holderOnLiveDate();
      const opened = ticketOf(await openCall(playback, viewer, dateId));
      playback.clock.advance(PLAYBACK_RENEWAL_INTERVAL_SECONDS * 1_000);
      const now = playback.clock.now();

      const renewed = await renewCall(playback, viewer, opened.sessionId);
      expect(renewed.statusCode).toBe(200);
      expect(renewed.headers['cache-control']).toBe('no-store');
      const renewal = (JSON.parse(renewed.body) as { data: Record<string, unknown> }).data;
      expect(renewal).toMatchObject({
        expiresAt: plusSeconds(now, PLAYBACK_TOKEN_LIFETIME_SECONDS),
        renewAfterSec: PLAYBACK_RENEWAL_INTERVAL_SECONDS,
        leaseExpiresAt: plusSeconds(now, PLAYBACK_LEASE_SECONDS),
        qualityCap: QualityCap.FHD,
        signature: { cookieSet: false },
      });
      expect(renewal).not.toHaveProperty('manifestUrl');

      expect((await releaseCall(playback, viewer, opened.sessionId)).statusCode).toBe(204);
      expect((await releaseCall(playback, viewer, opened.sessionId)).statusCode).toBe(204);
      const afterRelease = await renewCall(playback, viewer, opened.sessionId);
      expect(afterRelease.statusCode).toBe(404);
      expect(errorOf(afterRelease).code).toBe(ApiErrorCode.NOT_FOUND);
    },
    CASE_MS,
  );

  it(
    'refuses a renewal with no country header, and past its deadline',
    async () => {
      const { viewer, dateId } = await holderOnLiveDate();
      const { sessionId } = ticketOf(await openCall(playback, viewer, dateId));

      const countryless = await renewCall(playback, viewer, sessionId, { country: null });
      expect(countryless.statusCode).toBe(400);
      const past = new Date(playback.clock.nowMs() - 1_000).toISOString();
      expect((await renewCall(playback, viewer, sessionId, { deadline: past })).statusCode).toBe(
        504,
      );
      expect((await releaseCall(playback, viewer, sessionId, { deadline: past })).statusCode).toBe(
        504,
      );
    },
    CASE_MS,
  );

  it(
    'answers an unknown session 404 on both',
    async () => {
      const viewer = newViewer();
      expect((await renewCall(playback, viewer, randomUUID())).statusCode).toBe(404);
      expect((await releaseCall(playback, viewer, randomUUID())).statusCode).toBe(404);
    },
    CASE_MS,
  );
});
