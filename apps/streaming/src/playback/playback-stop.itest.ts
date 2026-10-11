import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PLAYBACK_RENEWAL_INTERVAL_SECONDS,
  PLAYBACK_TOKEN_LIFETIME_SECONDS,
  Surface,
  toEpochMs,
  type Instant,
  type StorefrontSurface,
} from '@arthome/core';

import {
  CASE_MS,
  STARTUP_MS,
  cancelSeat,
  deviceRevoked,
  grantSeat,
  liveDate,
  newViewer,
  openCall,
  renewCall,
  startPlayback,
  stopPlayback,
  ticketOf,
  type Playback,
  type Viewer,
} from '../itest/playback.js';

/**
 * `adr-stream-entitlement.md` §3.3: what is measured is playback stopping at the edge, not the
 *   renewal being refused. A player renews every 45 s and keeps pulling a segment every 2 s with
 *   the last credential it holds, ignoring every refusal; the fake edge decides each request.
 */

let playback: Playback;

beforeAll(async () => {
  playback = await startPlayback('streaming_playback_stop_itest');
}, STARTUP_MS);

afterAll(async () => {
  await stopPlayback(playback);
});

const SEGMENT_EVERY_SECONDS = 2;
/** Two renewals before the revocation, so the token in hand is a renewed one. */
const LAST_RENEWAL_BEFORE_REVOCATION = 2 * PLAYBACK_RENEWAL_INTERVAL_SECONDS;
const WATCHED_PAST_REVOCATION_SECONDS = PLAYBACK_TOKEN_LIFETIME_SECONDS + 60;

type Revocation = (viewer: Viewer, dateId: string, seatId: string) => Promise<void>;

const revokeDevice: Revocation = async (viewer) => {
  await playback.apply(deviceRevoked(viewer.accountId, viewer.deviceId, playback.clock.now()));
};

const cancelTheSeat: Revocation = (viewer, dateId, seatId) =>
  cancelSeat(playback, seatId, viewer.accountId, dateId);

interface Segment {
  readonly at: Instant;
  readonly served: boolean;
}

interface Measure {
  readonly revokedAt: Instant;
  /** When the renewing player was first refused. */
  readonly learnedAt: Instant;
  /** The expiry of the last token the player was given. */
  readonly lastExpiry: Instant;
  readonly segments: readonly Segment[];
}

interface Signed {
  readonly headers: Record<string, unknown>;
  readonly body: string;
}

interface Signature {
  readonly expiresAt: Instant;
  readonly signature?: { readonly queryToken?: string | null };
}

/** The query token, or the signed cookie's value: what the edge reads on every request. */
function credentialOf({ headers, body }: Signed): { credential: string; expiresAt: Instant } {
  const { data } = JSON.parse(body) as { data: Signature };
  const queryToken = data.signature?.queryToken;
  const cookie = /^arthome_playback=([^;]+);/.exec(String(headers['set-cookie']))?.[1];
  const credential = queryToken ?? cookie;
  if (credential === undefined) throw new Error('no credential in the answer');
  return { credential, expiresAt: data.expiresAt };
}

async function watchThrough(
  revocation: Revocation,
  secondsAfterRenewal: number,
  surface: StorefrontSurface = Surface.STOREFRONT_TV,
): Promise<Measure> {
  const viewer = newViewer();
  const dateId = await liveDate(playback);
  const seatId = await grantSeat(playback, viewer.accountId, dateId);
  const opened = await openCall(playback, viewer, dateId, { surface });
  const ticket = ticketOf(opened);
  const segmentPath = new URL(ticket.manifestUrl).pathname.replace(
    'master.m3u8',
    '720p/seg-000123.m4s',
  );
  let { credential, expiresAt: lastExpiry } = credentialOf(opened);
  let learnedAt: Instant | null = null;
  const revokeAtSecond = LAST_RENEWAL_BEFORE_REVOCATION + secondsAfterRenewal;
  let revokedAt: Instant | null = null;
  const segments: Segment[] = [];

  for (let second = 1; second <= revokeAtSecond + WATCHED_PAST_REVOCATION_SECONDS; second += 1) {
    playback.clock.advance(1_000);
    const now = playback.clock.now();
    if (second === revokeAtSecond) {
      await revocation(viewer, dateId, seatId);
      revokedAt = now;
    }
    if (learnedAt === null && second % PLAYBACK_RENEWAL_INTERVAL_SECONDS === 0) {
      const renewed = await renewCall(playback, viewer, ticket.sessionId, { surface });
      if (renewed.statusCode === 200) {
        ({ credential, expiresAt: lastExpiry } = credentialOf(renewed));
      } else {
        learnedAt = now;
      }
    }
    if (second % SEGMENT_EVERY_SECONDS === 0) {
      segments.push({
        at: now,
        served: await playback.fake.edgeServes(segmentPath, credential, now),
      });
    }
  }
  if (revokedAt === null || learnedAt === null) throw new Error('the scenario did not run through');
  return { revokedAt, learnedAt, lastExpiry, segments };
}

const secondsBetween = (from: Instant, to: Instant): number =>
  (toEpochMs(to) - toEpochMs(from)) / 1_000;

function expectStoppedAtTheEdge({ revokedAt, learnedAt, lastExpiry, segments }: Measure): number {
  const exposure = secondsBetween(revokedAt, lastExpiry);
  expect(exposure).toBeGreaterThan(0);
  expect(exposure).toBeLessThanOrEqual(PLAYBACK_TOKEN_LIFETIME_SECONDS);

  const learnedWithin = secondsBetween(revokedAt, learnedAt);
  expect(learnedWithin).toBeGreaterThan(0);
  expect(learnedWithin).toBeLessThanOrEqual(PLAYBACK_RENEWAL_INTERVAL_SECONDS);

  const afterExpiry = segments.filter(({ at }) => toEpochMs(at) >= toEpochMs(lastExpiry));
  expect(afterExpiry.length).toBeGreaterThan(0);
  expect(afterExpiry.filter(({ served }) => served)).toEqual([]);
  const beforeExpiry = segments.filter(({ at }) => toEpochMs(at) < toEpochMs(lastExpiry));
  expect(beforeExpiry.every(({ served }) => served)).toBe(true);
  return exposure;
}

describe('playback stopping at the edge after a revocation', () => {
  it.each([
    ['just after a renewal', 1],
    ['mid-interval', 22],
    ['just before a renewal', PLAYBACK_RENEWAL_INTERVAL_SECONDS - 1],
  ])(
    'stops within the token in hand for a device revoked %s',
    async (_when, secondsAfterRenewal) => {
      const exposure = expectStoppedAtTheEdge(
        await watchThrough(revokeDevice, secondsAfterRenewal),
      );
      expect(exposure).toBe(PLAYBACK_TOKEN_LIFETIME_SECONDS - secondsAfterRenewal);
    },
    CASE_MS,
  );

  it(
    'stops a browser on its signed cookie the same way when the seat is cancelled',
    async () => {
      expectStoppedAtTheEdge(await watchThrough(cancelTheSeat, 22, Surface.STOREFRONT_WEB));
    },
    CASE_MS,
  );
});
