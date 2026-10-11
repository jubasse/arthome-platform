import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PLAYBACK_LEASE_SECONDS,
  PlaybackSessionState,
  Surface,
  WatchDenialReason,
} from '@arthome/core';

import {
  CASE_MS,
  STARTUP_MS,
  cancelSeat,
  errorOf,
  grantSeat,
  liveDate,
  newViewer,
  onAnotherDevice,
  openCall,
  renewCall,
  sessionsOf,
  startPlayback,
  stopPlayback,
  subscribeMultiScreen,
  ticketOf,
  type Playback,
} from '../itest/playback.js';

/**
 * D-108's allowance and D-117's takeover over HTTP: as many screens as seats on the date, or the
 *   plan's ceiling if higher; an opening takes over the least recently renewed screen, whose next
 *   renewal is refused with the list; a lost seat refuses the oldest lease at its renewal.
 */

let playback: Playback;

beforeAll(async () => {
  playback = await startPlayback('streaming_screens_itest');
}, STARTUP_MS);

afterAll(async () => {
  await stopPlayback(playback);
});

const seconds = (n: number): void => {
  playback.clock.advance(n * 1_000);
};

describe('the screens of an account on a date', () => {
  it(
    'plays on two screens with two seats, then a third device takes over the least recently renewed',
    async () => {
      const tv = newViewer();
      const phone = onAnotherDevice(tv);
      const laptop = onAnotherDevice(tv);
      const dateId = await liveDate(playback);
      await grantSeat(playback, tv.accountId, dateId);
      await grantSeat(playback, tv.accountId, dateId);

      const onTv = ticketOf(await openCall(playback, tv, dateId));
      seconds(5);
      const onPhone = ticketOf(await openCall(playback, phone, dateId));
      seconds(10);
      expect((await renewCall(playback, phone, onPhone.sessionId)).statusCode).toBe(200);
      seconds(5);

      const onLaptop = ticketOf(
        await openCall(playback, laptop, dateId, {
          surface: Surface.STOREFRONT_WEB,
        }),
      );
      expect(onLaptop.resumedExistingSession).toBe(false);

      const refused = await renewCall(playback, tv, onTv.sessionId);
      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused)).toMatchObject({
        code: WatchDenialReason.CONCURRENT_LIMIT_REACHED,
        params: {
          allowed: 2,
          activeSessions: [
            expect.objectContaining({
              sessionId: onPhone.sessionId,
              deviceId: phone.deviceId,
              isCurrentDevice: false,
              deviceLabel: Surface.STOREFRONT_TV,
              city: null,
            }),
            expect.objectContaining({
              sessionId: onLaptop.sessionId,
              deviceId: laptop.deviceId,
              isCurrentDevice: false,
              deviceLabel: Surface.STOREFRONT_WEB,
            }),
          ],
        },
      });
      expect(JSON.stringify(errorOf(refused))).not.toMatch(/token|cookie|scope/i);
      expect(await sessionsOf(playback, tv.accountId)).toEqual([
        expect.objectContaining({
          id: onTv.sessionId,
          state: PlaybackSessionState.REVOKED,
          revoke_reason: WatchDenialReason.CONCURRENT_LIMIT_REACHED,
        }),
        expect.objectContaining({ id: onPhone.sessionId, state: PlaybackSessionState.ACTIVE }),
        expect.objectContaining({ id: onLaptop.sessionId, state: PlaybackSessionState.ACTIVE }),
      ]);

      // The television takes its screen back from the phone, renewed before the laptop opened.
      const back = ticketOf(await openCall(playback, tv, dateId));
      expect(back.sessionId).not.toBe(onTv.sessionId);
      const phoneRefused = await renewCall(playback, phone, onPhone.sessionId);
      expect(errorOf(phoneRefused).code).toBe(WatchDenialReason.CONCURRENT_LIMIT_REACHED);
      expect((await renewCall(playback, laptop, onLaptop.sessionId)).statusCode).toBe(200);
    },
    CASE_MS,
  );

  it(
    'refuses the oldest lease at its renewal once a seat is cancelled, the newest keeping its screen',
    async () => {
      const tv = newViewer();
      const phone = onAnotherDevice(tv);
      const dateId = await liveDate(playback);
      const seat = await grantSeat(playback, tv.accountId, dateId);
      await grantSeat(playback, tv.accountId, dateId);
      const onTv = ticketOf(await openCall(playback, tv, dateId));
      seconds(1);
      const onPhone = ticketOf(await openCall(playback, phone, dateId));

      await cancelSeat(playback, seat, tv.accountId, dateId);
      seconds(30);

      const refused = await renewCall(playback, tv, onTv.sessionId);
      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused)).toMatchObject({
        code: WatchDenialReason.CONCURRENT_LIMIT_REACHED,
        params: { allowed: 1, activeSessions: [{ sessionId: onPhone.sessionId }] },
      });
      expect((await renewCall(playback, phone, onPhone.sessionId)).statusCode).toBe(200);
    },
    CASE_MS,
  );

  it(
    "resumes the device's own lease: the same session, a fresh lease, no second screen",
    async () => {
      const tv = newViewer();
      const dateId = await liveDate(playback);
      await grantSeat(playback, tv.accountId, dateId);
      const first = ticketOf(await openCall(playback, tv, dateId));
      seconds(20);

      const again = ticketOf(await openCall(playback, tv, dateId));

      expect(again.sessionId).toBe(first.sessionId);
      expect(again.resumedExistingSession).toBe(true);
      expect(again.leaseExpiresAt > first.leaseExpiresAt).toBe(true);
      expect(again.manifestUrl).toBe(first.manifestUrl);
      expect(await sessionsOf(playback, tv.accountId)).toHaveLength(1);
    },
    CASE_MS,
  );

  it(
    'opens a new session on a device whose lease lapsed, the lapsed one expired',
    async () => {
      const tv = newViewer();
      const dateId = await liveDate(playback);
      await grantSeat(playback, tv.accountId, dateId);
      const first = ticketOf(await openCall(playback, tv, dateId));
      seconds(PLAYBACK_LEASE_SECONDS);

      const reopened = ticketOf(await openCall(playback, tv, dateId));

      expect(reopened.sessionId).not.toBe(first.sessionId);
      expect(reopened.resumedExistingSession).toBe(false);
      expect(await sessionsOf(playback, tv.accountId)).toEqual([
        expect.objectContaining({ id: first.sessionId, state: PlaybackSessionState.EXPIRED }),
        expect.objectContaining({ id: reopened.sessionId, state: PlaybackSessionState.ACTIVE }),
      ]);
    },
    CASE_MS,
  );

  it(
    "gives a multi-screen subscriber with no seat the plan's two screens",
    async () => {
      const tv = newViewer();
      const phone = onAnotherDevice(tv);
      const laptop = onAnotherDevice(tv);
      const dateId = await liveDate(playback);
      await subscribeMultiScreen(playback, tv.accountId);

      const onTv = ticketOf(await openCall(playback, tv, dateId));
      seconds(1);
      ticketOf(await openCall(playback, phone, dateId));
      seconds(1);
      ticketOf(await openCall(playback, laptop, dateId));

      const active = (await sessionsOf(playback, tv.accountId)).filter(
        ({ state }) => state === PlaybackSessionState.ACTIVE,
      );
      expect(active.map(({ device_id }) => device_id)).toEqual([phone.deviceId, laptop.deviceId]);
      expect(errorOf(await renewCall(playback, tv, onTv.sessionId)).code).toBe(
        WatchDenialReason.CONCURRENT_LIMIT_REACHED,
      );
    },
    CASE_MS,
  );
});
