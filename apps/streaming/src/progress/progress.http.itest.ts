import { randomUUID } from 'node:crypto';

import { guardDeclaredResponses } from '@arthome-platform/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { streamingServiceApi } from '@arthome/contracts/streaming-service-api';
import { ApiErrorCode, InternalTokenIssuer, RunState } from '@arthome/core';

import {
  CASE_MS,
  STARTUP_MS,
  errorOf,
  identityId,
  liveDate,
  newViewer,
  onAnotherDevice,
  openCall,
  releaseCall,
  setRun,
  startPlayback,
  stopPlayback,
  ticketOf,
  type Playback,
} from '../itest/playback.js';
import { batchCall, pointOf, recordCall, storedPoint, tableOf } from '../itest/progress.js';

/**
 * The two resume-point routes over HTTP on a real Postgres, every answer checked against
 *   `streamingServiceApi`'s declaration.
 */

const responses = guardDeclaredResponses(streamingServiceApi);

let playback: Playback;

beforeAll(async () => {
  playback = await startPlayback('streaming_progress_http_itest', { watch: responses });
}, STARTUP_MS);

afterAll(async () => {
  await stopPlayback(playback);
});

async function endedDate(): Promise<string> {
  return liveDate(playback, { runState: RunState.ENDED });
}

describe('recordPlaybackPosition', () => {
  it(
    'records nothing during a live and answers the stored point unchanged, {} when there is none',
    async () => {
      const viewer = newViewer();
      const dateId = await liveDate(playback);

      expect(pointOf(await recordCall(playback, viewer, dateId, 90))).toEqual({});
      expect(await storedPoint(playback, viewer.profileId, dateId)).toBeUndefined();

      await playback.dataSource.query(
        `INSERT INTO resume_point (owner_id, date_id, account_id, profile_id, device_id,
                                   position_sec, completed, version, written_at)
              VALUES ($1, $2, $3, $1, $4, 500, false, 3, now())`,
        [viewer.profileId, dateId, viewer.accountId, viewer.deviceId],
      );
      expect(pointOf(await recordCall(playback, viewer, dateId, 90))).toEqual({
        positionSec: 500,
        version: 3,
      });
      expect((await storedPoint(playback, viewer.profileId, dateId))?.position_sec).toBe(500);
    },
    CASE_MS,
  );

  it(
    'records nothing for a date with no run',
    async () => {
      const viewer = newViewer();
      const dateId = await liveDate(playback, { runState: null });

      expect(pointOf(await recordCall(playback, viewer, dateId, 10))).toEqual({});
      expect(await storedPoint(playback, viewer.profileId, dateId)).toBeUndefined();
    },
    CASE_MS,
  );

  it(
    'refuses a date the entitlement projection does not hold, api.not_found, writing nothing',
    async () => {
      const viewer = newViewer();
      const unknown = randomUUID();

      const recorded = await recordCall(playback, viewer, unknown, 10);

      expect(recorded.statusCode).toBe(404);
      expect(errorOf(recorded).code).toBe(ApiErrorCode.NOT_FOUND);
      expect(await storedPoint(playback, viewer.profileId, unknown)).toBeUndefined();
    },
    CASE_MS,
  );

  it(
    'grows the version by one per write after the run ended, the last writer winning',
    async () => {
      const viewer = newViewer();
      const dateId = await endedDate();

      expect(pointOf(await recordCall(playback, viewer, dateId, 600))).toEqual({
        positionSec: 600,
        version: 1,
      });
      const otherScreen = onAnotherDevice(viewer);
      expect(pointOf(await recordCall(playback, otherScreen, dateId, 120))).toEqual({
        positionSec: 120,
        version: 2,
      });
      expect(pointOf(await recordCall(playback, viewer, dateId, 900))).toEqual({
        positionSec: 900,
        version: 3,
      });
      expect(await storedPoint(playback, viewer.profileId, dateId)).toMatchObject({
        position_sec: 900,
        version: '3',
        device_id: viewer.deviceId,
      });
    },
    CASE_MS,
  );

  it(
    'keeps a write that arrives after the screen was released',
    async () => {
      const viewer = newViewer();
      const dateId = await liveDate(playback);
      const { sessionId } = ticketOf(await openCall(playback, viewer, dateId));
      expect((await releaseCall(playback, viewer, sessionId)).statusCode).toBe(204);
      await setRun(playback, dateId, RunState.ENDED);

      expect(pointOf(await recordCall(playback, viewer, dateId, 1_800))).toEqual({
        positionSec: 1_800,
        version: 1,
      });
    },
    CASE_MS,
  );

  it(
    'keeps one point per profile of the account',
    async () => {
      const viewer = newViewer();
      const dateId = await endedDate();
      const sibling = { ...viewer, profileId: identityId() };

      await recordCall(playback, viewer, dateId, 100);
      expect(pointOf(await recordCall(playback, sibling, dateId, 40))).toEqual({
        positionSec: 40,
        version: 1,
      });
    },
    CASE_MS,
  );

  it(
    'refuses 403 a device that is not the token, a token with no profile and a token with no user',
    async () => {
      const viewer = newViewer();
      const dateId = await endedDate();

      const otherDevice = await recordCall(playback, viewer, dateId, 5, {
        body: { deviceId: identityId() },
      });
      const noProfile = await recordCall(playback, viewer, dateId, 5, {
        token: { profileId: null },
      });
      const noDevice = await recordCall(playback, viewer, dateId, 5, { token: { deviceId: null } });
      const noUser = await recordCall(playback, viewer, dateId, 5, { token: { accountId: null } });

      for (const refused of [otherDevice, noProfile, noDevice, noUser]) {
        expect(refused.statusCode).toBe(403);
        expect(errorOf(refused).code).toBe(ApiErrorCode.FORBIDDEN);
      }
      expect(await storedPoint(playback, viewer.profileId, dateId)).toBeUndefined();
    },
    CASE_MS,
  );

  it(
    'refuses the studio control room and a past deadline, before any write',
    async () => {
      const viewer = newViewer();
      const dateId = await endedDate();
      const past = new Date(playback.clock.nowMs() - 1_000).toISOString();

      const studio = await recordCall(playback, viewer, dateId, 5, {
        issuer: InternalTokenIssuer.STUDIO_BFF,
      });
      const late = await recordCall(playback, viewer, dateId, 5, { deadline: past });

      expect(studio.statusCode).toBe(403);
      expect(late.statusCode).toBe(504);
      expect(await storedPoint(playback, viewer.profileId, dateId)).toBeUndefined();
    },
    CASE_MS,
  );
});

describe('getViewerProgressBatch', () => {
  it(
    'answers a table of the caller points only, a date without one absent',
    async () => {
      const viewer = newViewer();
      const sibling = { ...viewer, profileId: identityId() };
      const stranger = newViewer();
      const [first, second, none] = [await endedDate(), await endedDate(), await endedDate()];
      await recordCall(playback, viewer, first, 300, { body: { completed: true } });
      await recordCall(playback, viewer, second, 20);
      await recordCall(playback, sibling, none, 77);
      await recordCall(playback, stranger, none, 99);

      const table = tableOf(await batchCall(playback, viewer, [first, second, none]));

      expect(Object.keys(table).sort()).toEqual([first, second].sort());
      expect(table[first]).toMatchObject({ positionSec: 300, completed: true, version: 1 });
      expect(table[second]).toMatchObject({ positionSec: 20, completed: false, version: 1 });
      expect(table[first]?.writtenAt).toEqual(expect.any(String));
    },
    CASE_MS,
  );

  it(
    'passes 200 ids and refuses 201',
    async () => {
      const viewer = newViewer();
      const ids = (count: number): string[] => Array.from({ length: count }, () => randomUUID());

      const bounded = await batchCall(playback, viewer, ids(200));
      const over = await batchCall(playback, viewer, ids(201));
      const empty = await batchCall(playback, viewer, []);

      expect(tableOf(bounded)).toEqual({});
      expect(over.statusCode).toBe(400);
      expect(empty.statusCode).toBe(400);
    },
    CASE_MS,
  );

  it(
    'refuses 403 a profile that is not the token, a token with no profile and one with no user',
    async () => {
      const viewer = newViewer();
      const dateId = await endedDate();

      const otherProfile = await batchCall(playback, viewer, [dateId], {
        body: { profileId: identityId() },
      });
      const noProfile = await batchCall(playback, viewer, [dateId], { token: { profileId: null } });
      const noUser = await batchCall(playback, viewer, [dateId], { token: { accountId: null } });

      for (const refused of [otherProfile, noProfile, noUser]) {
        expect(refused.statusCode).toBe(403);
        expect(errorOf(refused).code).toBe(ApiErrorCode.FORBIDDEN);
      }
    },
    CASE_MS,
  );
});
