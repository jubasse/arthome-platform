import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PLAYBACK_TOKEN_LIFETIME_SECONDS,
  PREVIEW_BUDGET_SECONDS,
  WatchDenialReason,
  WatchScope,
  plusSeconds,
} from '@arthome/core';

import {
  CASE_MS,
  STARTUP_MS,
  errorOf,
  identityId,
  liveDate,
  newViewer,
  onAnotherDevice,
  openCall,
  renewCall,
  startPlayback,
  stopPlayback,
  ticketOf,
  type Playback,
} from '../itest/playback.js';
import { budgetOf, raiseVeil, resolveVeil } from '../itest/preview.js';

/**
 * The preview budget through PS3's routes on one `FixedClock`: a token never outlives the budget
 *   left, the account's budget is shared by its devices and the veil's time comes back.
 */

let playback: Playback;

beforeAll(async () => {
  playback = await startPlayback('streaming_preview_budget_itest');
}, STARTUP_MS);

afterAll(async () => {
  await stopPlayback(playback);
});

describe('the preview budget', () => {
  it(
    'issues 120 s then walks to the budget: every expiry is min(now + 120 s, now + left), then the renewal is refused',
    async () => {
      const viewer = newViewer();
      const dateId = await liveDate(playback);
      let spent = 0;
      let ticket = ticketOf(await openCall(playback, viewer, dateId));

      for (;;) {
        const left = PREVIEW_BUDGET_SECONDS - spent;
        expect(ticket.scope).toBe(WatchScope.PREVIEW);
        expect(ticket.expiresAt).toBe(
          plusSeconds(playback.clock.now(), Math.min(PLAYBACK_TOKEN_LIFETIME_SECONDS, left)),
        );
        playback.clock.advance(ticket.renewAfterSec * 1000);
        spent += ticket.renewAfterSec;
        const renewed = await renewCall(playback, viewer, ticket.sessionId);
        if (renewed.statusCode !== 200) {
          expect(renewed.statusCode).toBe(403);
          expect(errorOf(renewed).code).toBe(WatchDenialReason.PREVIEW_EXHAUSTED);
          break;
        }
        ticket = { ...ticket, ...(JSON.parse(renewed.body) as { data: typeof ticket }).data };
      }

      expect(spent).toBe(PREVIEW_BUDGET_SECONDS);
      const row = await budgetOf(playback, viewer.accountId, dateId);
      expect((row?.settled_seconds ?? 0) + (row?.precharged_seconds ?? 0)).toBe(
        PREVIEW_BUDGET_SECONDS,
      );
      const reopened = await openCall(playback, viewer, dateId);
      expect(errorOf(reopened).code).toBe(WatchDenialReason.PREVIEW_EXHAUSTED);
    },
    CASE_MS,
  );

  it(
    'shares one budget across the account: a second device and a reinstall spend the same seconds',
    async () => {
      const first = newViewer();
      const dateId = await liveDate(playback);
      ticketOf(await openCall(playback, first, dateId));

      playback.clock.advance(20_000);
      const second = ticketOf(await openCall(playback, onAnotherDevice(first), dateId));
      expect(second.previewSecondsLeft).toBe(PREVIEW_BUDGET_SECONDS - 20);

      playback.clock.advance(80_000);
      const reinstalled = ticketOf(
        await openCall(playback, { ...first, deviceId: identityId() }, dateId),
      );
      expect(reinstalled.previewSecondsLeft).toBe(PREVIEW_BUDGET_SECONDS - 100);
      expect((await budgetOf(playback, first.accountId, dateId))?.settled_seconds).toBe(100);
    },
    CASE_MS,
  );

  it(
    'keeps the budget of two accounts apart',
    async () => {
      const dateId = await liveDate(playback);
      const one = newViewer();
      const other = newViewer();
      const opened = ticketOf(await openCall(playback, one, dateId));
      playback.clock.advance(opened.renewAfterSec * 1000);
      await renewCall(playback, one, opened.sessionId);

      const fresh = ticketOf(await openCall(playback, other, dateId));

      expect(fresh.previewSecondsLeft).toBe(PREVIEW_BUDGET_SECONDS);
    },
    CASE_MS,
  );

  it(
    'gives the veil back: a 60 s hold screen costs nothing, and the token is still capped at what is left',
    async () => {
      const viewer = newViewer();
      const dateId = await liveDate(playback);
      const opened = ticketOf(await openCall(playback, viewer, dateId));

      playback.clock.advance(30_000);
      await raiseVeil(playback, dateId);
      playback.clock.advance(15_000);
      const underVeil = await renewCall(playback, viewer, opened.sessionId);
      expect(underVeil.statusCode).toBe(200);
      expect(await budgetOf(playback, viewer.accountId, dateId)).toMatchObject({
        settled_seconds: 30,
        precharged_seconds: 0,
      });

      playback.clock.advance(45_000);
      await resolveVeil(playback, dateId);
      playback.clock.advance(10_000);
      const afterVeil = await renewCall(playback, viewer, opened.sessionId);

      expect(afterVeil.statusCode).toBe(200);
      expect((await budgetOf(playback, viewer.accountId, dateId))?.settled_seconds).toBe(40);
    },
    CASE_MS,
  );
});
