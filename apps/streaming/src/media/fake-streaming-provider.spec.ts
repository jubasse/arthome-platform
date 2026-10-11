import { generateKeyPairSync } from 'node:crypto';

import { readPlaybackSigningKey } from '@arthome-platform/config';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';

import { EdgeRenewalMode, QualityCap } from '@arthome/contracts/streaming';
import { FixedClock, WatchScope, plusSeconds } from '@arthome/core';

import {
  FAKE_WORKER_GRACE_MS,
  FAKE_WORKER_RESTART_DELAYS_MS,
  FakeStreamingProvider,
} from './fake-streaming-provider.js';
import {
  IngestProtocol,
  MediaCodec,
  MonitorPath,
  PlaybackSigningUnavailable,
  RecordingNotFound,
  codecsCarried,
  type IngestAttempt,
  type IngestDecision,
  type PlaybackGrant,
  type PublisherOffline,
  type PublisherOnline,
  type WorkerFailed,
} from './media-ports.js';

const START = '2026-10-06T19:00:00.000Z';
const PATH = 'k7Qe2pLx9vWm';
const KEY = 'the-date-stream-key';
const DATE_ID = '01a0e700-0000-7000-8000-0000000000a1';
const SESSION_SCOPE = '01a0e700-0000-7000-8000-0000000000b1';
const signingKey = readPlaybackSigningKey({ NODE_ENV: 'test' });

/** The domain's side of the hooks: it accepts one key, and records what it is told. */
class RecordingHooks {
  public readonly attempts: IngestAttempt[] = [];
  public readonly online: PublisherOnline[] = [];
  public readonly offline: PublisherOffline[] = [];
  public readonly failures: WorkerFailed[] = [];
  public acceptedKey = KEY;

  public readonly authorizer = {
    authorize: (attempt: IngestAttempt): Promise<IngestDecision> => {
      this.attempts.push(attempt);
      return Promise.resolve(
        attempt.presentedKey === this.acceptedKey
          ? { accepted: true }
          : { accepted: false, reason: 'unknown_key' },
      );
    },
  };

  public readonly listener = {
    publisherOnline: (event: PublisherOnline): Promise<void> => {
      this.online.push(event);
      return Promise.resolve();
    },
    publisherOffline: (event: PublisherOffline): Promise<void> => {
      this.offline.push(event);
      return Promise.resolve();
    },
    workerFailed: (event: WorkerFailed): Promise<void> => {
      this.failures.push(event);
      return Promise.resolve();
    },
  };
}

let clock: FixedClock;
let fake: FakeStreamingProvider;
let hooks: RecordingHooks;

beforeEach(() => {
  clock = new FixedClock(START);
  fake = new FakeStreamingProvider({ signingKey, clock });
  hooks = new RecordingHooks();
});

const attach = (): void => {
  fake.attachIngestHooks({ authorizer: hooks.authorizer, listener: hooks.listener });
};

const rtmps = { protocol: IngestProtocol.RTMPS };

describe('ingest', () => {
  it('refuses every feed until the hooks are attached', async () => {
    const decision = await fake.publish(PATH, KEY, rtmps);

    expect(decision).toEqual({ accepted: false, reason: 'no ingest hooks are attached' });
    expect(fake.manifestGeneration(PATH)).toBe(0);
    expect(() => {
      attach();
      attach();
    }).toThrow(/attached once/);
  });

  it('asks the authorizer before accepting, and a refusal accepts nothing', async () => {
    attach();
    fake.setFeedSample(PATH, {
      videoCodec: MediaCodec.H264,
      audioCodec: MediaCodec.AAC,
      ingestUpKbps: 4200,
    });

    const decision = await fake.publish(PATH, 'a-guessed-key', rtmps);

    expect(decision).toEqual({ accepted: false, reason: 'unknown_key' });
    expect(hooks.attempts).toEqual([
      { streamPath: PATH, presentedKey: 'a-guessed-key', protocol: IngestProtocol.RTMPS },
    ]);
    expect(hooks.online).toEqual([]);
    expect(await fake.sample(PATH)).toBeNull();
    expect(fake.manifestGeneration(PATH)).toBe(0);
  });

  it('refuses a second publisher on a path that has one', async () => {
    attach();
    expect(await fake.publish(PATH, KEY, rtmps)).toEqual({ accepted: true });

    const second = await fake.publish(PATH, KEY, { protocol: IngestProtocol.SRT });

    expect(second).toEqual({ accepted: false, reason: 'the path already has a publisher' });
    expect(hooks.online).toHaveLength(1);
  });

  it('refuses a protocol it does not ingest before asking anyone', async () => {
    const narrow = new FakeStreamingProvider({
      signingKey,
      clock,
      ingestCapabilities: { protocols: [IngestProtocol.RTMPS] },
    });
    narrow.attachIngestHooks({ authorizer: hooks.authorizer, listener: hooks.listener });

    expect(await narrow.publish(PATH, KEY, { protocol: IngestProtocol.WHIP })).toMatchObject({
      accepted: false,
    });
    expect(hooks.attempts).toEqual([]);
  });

  it('reports each connection and loss with its instant, deciding nothing', async () => {
    attach();
    await fake.publish(PATH, KEY, rtmps);
    clock.advance(10_000);
    await fake.drop(PATH);
    clock.advance(1_000);
    await fake.resume(PATH);
    clock.advance(60_000);
    await fake.disconnect(PATH);
    await fake.disconnect(PATH);

    expect(hooks.online).toEqual([
      { streamPath: PATH, protocol: IngestProtocol.RTMPS, at: START },
      { streamPath: PATH, protocol: IngestProtocol.RTMPS, at: plusSeconds(START, 11) },
    ]);
    expect(hooks.offline).toEqual([
      { streamPath: PATH, at: plusSeconds(START, 10) },
      { streamPath: PATH, at: plusSeconds(START, 71) },
    ]);
  });

  it('authorises a resume again, so a key rotated during the drop lets nothing back', async () => {
    attach();
    await fake.publish(PATH, KEY, rtmps);
    await fake.drop(PATH);
    hooks.acceptedKey = 'the-rotated-key';

    expect(await fake.resume(PATH)).toEqual({ accepted: false, reason: 'unknown_key' });
    expect(hooks.online).toHaveLength(1);
  });

  it('keeps the manifest generation for a resume inside the worker grace, and moves it past', async () => {
    attach();
    await fake.publish(PATH, KEY, rtmps);
    expect(fake.manifestGeneration(PATH)).toBe(1);

    await fake.drop(PATH);
    clock.advance(FAKE_WORKER_GRACE_MS - 1);
    await fake.resume(PATH);
    expect(fake.manifestGeneration(PATH)).toBe(1);

    await fake.drop(PATH);
    clock.advance(FAKE_WORKER_GRACE_MS);
    await fake.resume(PATH);
    expect(fake.manifestGeneration(PATH)).toBe(2);
  });

  it('restarts a failed worker three times at increasing delays, then reports one final failure', async () => {
    attach();
    await fake.publish(PATH, KEY, rtmps);

    await fake.failWorker(PATH);

    const restarts = [plusSeconds(START, 1), plusSeconds(START, 3), plusSeconds(START, 7)];

    expect(FAKE_WORKER_RESTART_DELAYS_MS).toEqual([1_000, 2_000, 4_000]);
    expect(fake.workerRestartsOf(PATH)).toEqual(restarts);
    expect(hooks.failures).toEqual([
      { streamPath: PATH, attempts: 3, final: true, at: plusSeconds(START, 7) },
    ]);
    expect(clock.now()).toBe(START);
  });

  it('serves its ingest and monitor addresses from the stream path alone', () => {
    expect(fake.ingestUrlFor(IngestProtocol.RTMPS, PATH)).toMatch(
      new RegExp(`^rtmps://.+/${PATH}$`),
    );
    expect(fake.ingestUrlFor(IngestProtocol.WHIP, PATH)).toMatch(/^https:\/\//);
    expect(fake.monitorUrlFor(MonitorPath.LL_HLS, PATH)).toMatch(/\.m3u8$/);
    expect(fake.monitorUrlFor(MonitorPath.WHEP, PATH)).toMatch(/whep$/);
  });
});

describe('metrics', () => {
  const reading = {
    videoCodec: MediaCodec.H264,
    audioCodec: MediaCodec.OPUS,
    ingestUpKbps: 3100,
    jitterMs: 12,
    lostPackets: 4,
  };

  it('answers null with no publisher', async () => {
    attach();
    fake.setFeedSample(PATH, reading);

    expect(await fake.sample(PATH)).toBeNull();
  });

  it('carries jitter and lost packets on whip, and leaves them out on rtmps', async () => {
    attach();
    await fake.publish(PATH, KEY, { protocol: IngestProtocol.WHIP });
    fake.setFeedSample(PATH, reading);
    expect(await fake.sample(PATH)).toEqual({
      ...reading,
      measuredAt: START,
      protocol: IngestProtocol.WHIP,
    });

    await fake.disconnect(PATH);
    await fake.publish(PATH, KEY, rtmps);
    const overRtmps = await fake.sample(PATH);

    expect(overRtmps).toMatchObject({ protocol: IngestProtocol.RTMPS, ingestUpKbps: 3100 });
    expect(overRtmps).not.toHaveProperty('jitterMs');
    expect(overRtmps).not.toHaveProperty('lostPackets');
  });

  it('tells the check whether the chain carries a sample’s codecs on its protocol', () => {
    const sample = {
      measuredAt: START,
      videoCodec: MediaCodec.H264,
      ingestUpKbps: 3100,
    };
    const capabilities = fake.ingestCapabilities;

    expect(
      codecsCarried(capabilities, {
        ...sample,
        protocol: IngestProtocol.WHIP,
        audioCodec: MediaCodec.OPUS,
      }),
    ).toBe(true);
    expect(
      codecsCarried(capabilities, {
        ...sample,
        protocol: IngestProtocol.RTMPS,
        audioCodec: MediaCodec.AAC,
      }),
    ).toBe(true);
    expect(
      codecsCarried(capabilities, {
        ...sample,
        protocol: IngestProtocol.RTMPS,
        audioCodec: MediaCodec.OPUS,
      }),
    ).toBe(false);
    expect(
      codecsCarried(capabilities, {
        ...sample,
        protocol: IngestProtocol.WHIP,
        videoCodec: 'vp8',
        audioCodec: MediaCodec.OPUS,
      }),
    ).toBe(false);
  });
});

describe('recording', () => {
  it('is ready with its duration once processed, and deleting it twice is harmless', async () => {
    const ref = await fake.start(PATH);
    expect(await fake.status(ref)).toEqual({ ready: false, durationSec: null });

    await fake.stop(ref);
    fake.markReady(ref, 6_480);
    expect(await fake.status(ref)).toEqual({ ready: true, durationSec: 6_480 });

    await fake.delete(ref);
    await fake.delete(ref);
    await expect(fake.status(ref)).rejects.toBeInstanceOf(RecordingNotFound);
  });

  it('answers an opaque reference that names no stream path', async () => {
    expect(await fake.start(PATH)).not.toContain(PATH);
  });
});

describe('signed playback', () => {
  const expiresAt = plusSeconds(START, 120);
  const grant = (mechanism: PlaybackGrant['mechanism']): PlaybackGrant => ({
    dateId: DATE_ID,
    sessionScope: SESSION_SCOPE,
    claims: {
      sub: '01a0e700-0000-7000-8000-0000000000d1',
      did: '01a0e700-0000-7000-8000-0000000000e1',
      dat: DATE_ID,
      sid: SESSION_SCOPE,
      qmax: QualityCap.FHD,
      scope: WatchScope.FULL,
      jti: '01a0e700-0000-7000-8000-0000000000f1',
    },
    expiresAt,
    mechanism,
  });
  const prefix = `/playback/${DATE_ID}/${SESSION_SCOPE}/`;

  it('signs ES256 under its kid, the claims given and exp from the grant, the token out of the URL', async () => {
    const signed = await fake.sign(grant(EdgeRenewalMode.QUERY_TOKEN));
    const token = signed.queryToken!;

    expect(decodeProtectedHeader(token)).toEqual({ alg: 'ES256', kid: signingKey.keyId });
    expect(decodeJwt(token)).toMatchObject({
      ...grant(EdgeRenewalMode.QUERY_TOKEN).claims,
      exp: Date.parse(expiresAt) / 1_000,
    });
    expect(signed.keyId).toBe(signingKey.keyId);
    expect(signed.cookies).toEqual([]);
    expect(new URL(signed.manifestUrl).pathname).toBe(`${prefix}master.m3u8`);
    expect(signed.manifestUrl).not.toContain(token);
  });

  it('sets the token as a cookie on the prefix when the mechanism is signed_cookie', async () => {
    const signed = await fake.sign(grant(EdgeRenewalMode.SIGNED_COOKIE));

    expect(signed.queryToken).toBeNull();
    expect(signed.cookies).toEqual([
      expect.objectContaining({ path: prefix, expiresAt, value: expect.any(String) as string }),
    ]);
  });

  it('refuses a mechanism its capabilities do not declare, rather than serving unsigned', async () => {
    const cookiesOnly = new FakeStreamingProvider({
      signingKey,
      clock,
      playbackCapabilities: { supportsQueryTokenRenewal: false },
    });

    await expect(cookiesOnly.sign(grant(EdgeRenewalMode.QUERY_TOKEN))).rejects.toBeInstanceOf(
      PlaybackSigningUnavailable,
    );
    await expect(cookiesOnly.sign(grant(EdgeRenewalMode.SIGNED_COOKIE))).resolves.toMatchObject({
      queryToken: null,
    });
  });

  it('serves the manifest and the segments under the prefix until exp, and not one second more', async () => {
    const token = (await fake.sign(grant(EdgeRenewalMode.QUERY_TOKEN))).queryToken!;
    const before = plusSeconds(expiresAt, -1);

    expect(await fake.edgeServes(`${prefix}master.m3u8`, token, before)).toBe(true);
    expect(await fake.edgeServes(`${prefix}fhd/seg-000123.m4s`, token, before)).toBe(true);
    expect(await fake.edgeServes(`${prefix}master.m3u8`, token, expiresAt)).toBe(false);
  });

  it('serves nothing outside the prefix, an encoded climb included', async () => {
    const token = (await fake.sign(grant(EdgeRenewalMode.QUERY_TOKEN))).queryToken!;
    const otherSession = `/playback/${DATE_ID}/01a0e700-0000-7000-8000-0000000000b2/master.m3u8`;

    expect(await fake.edgeServes(otherSession, token, START)).toBe(false);
    expect(await fake.edgeServes(`${prefix}../01a0e700/master.m3u8`, token, START)).toBe(false);
    expect(await fake.edgeServes(`${prefix}%2e%2e/x/master.m3u8`, token, START)).toBe(false);
    expect(await fake.edgeServes(prefix, token, START)).toBe(false);
  });

  it('serves nothing for a tampered signature or a kid it does not know', async () => {
    const token = (await fake.sign(grant(EdgeRenewalMode.QUERY_TOKEN))).queryToken!;
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const flipped = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    const renamed = new FakeStreamingProvider({
      signingKey: { ...signingKey, keyId: 'play-unknown' },
      clock,
    });
    const stranger = new FakeStreamingProvider({
      signingKey: {
        keyId: signingKey.keyId,
        privateJwk: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
          format: 'jwk',
        }) as Record<string, string>,
      },
      clock,
    });
    const page = `${prefix}master.m3u8`;

    expect(await fake.edgeServes(page, `${header}.${payload}.${flipped}`, START)).toBe(false);
    for (const other of [renamed, stranger]) {
      const foreign = (await other.sign(grant(EdgeRenewalMode.QUERY_TOKEN))).queryToken!;
      expect(await fake.edgeServes(page, foreign, START)).toBe(false);
    }
  });
});
