import { createHash, createHmac } from 'node:crypto';

import { readPlaybackSigningKey } from '@arthome-platform/config';
import { describe, expect, it } from 'vitest';

import { PublicationState, Surface, FixedClock } from '@arthome/core';

import { runConsoleOf } from './run-console.js';
import { Run } from './run.aggregate.js';
import { digestsMatch, newStreamPath, streamKeyDigestOf, streamKeyOf } from './stream-key.js';
import { FakeStreamingProvider } from '../media/fake-streaming-provider.js';

const SECRET = 'a-stream-key-secret-of-thirty-two-characters';
const RUN_ID = '01a0f000-0000-7000-8000-000000000001';
const NOW = '2026-09-29T20:00:00.000Z';

describe('the stream key', () => {
  it('is the HMAC-SHA-256 of the run and its generation, base64url', () => {
    const expected = createHmac('sha256', SECRET).update(`${RUN_ID}:1`).digest('base64url');
    expect(streamKeyOf(SECRET, RUN_ID, 1)).toBe(expected);
    expect(streamKeyOf(SECRET, RUN_ID, 2)).not.toBe(expected);
    expect(streamKeyOf(`${SECRET}-other`, RUN_ID, 1)).not.toBe(expected);
  });

  it('is kept as its SHA-256 digest, which matches in constant time', () => {
    const key = streamKeyOf(SECRET, RUN_ID, 1);
    const digest = streamKeyDigestOf(key);
    expect(digest).toBe(createHash('sha256').update(key).digest('base64url'));
    expect(digest).not.toContain(key);
    expect(digestsMatch(streamKeyDigestOf(key), digest)).toBe(true);
    expect(digestsMatch(streamKeyDigestOf(`${key}x`), digest)).toBe(false);
    expect(digestsMatch('short', digest)).toBe(false);
  });

  it('rides a path of 128 random bits', () => {
    const path = newStreamPath();
    expect(Buffer.from(path, 'base64url')).toHaveLength(16);
    expect(newStreamPath()).not.toBe(path);
  });

  it('is absent from every shape the run serialises: snapshot, events, console', () => {
    const key = streamKeyOf(SECRET, RUN_ID, 1);
    const run = Run.prepare(
      {
        runId: RUN_ID,
        dateId: '01a0f000-0000-7000-8000-000000000002',
        channelId: '01a0f000-0000-7000-8000-000000000003',
        streamPath: newStreamPath(),
      },
      NOW,
    );
    run.runTechnicalCheck(
      [],
      run.snapshot.ingestProtocol,
      { accountId: null, surface: Surface.SYSTEM },
      NOW,
    );
    run.goOnAir(2, PublicationState.TECHNICAL, { accountId: null, surface: Surface.SYSTEM }, NOW);
    const ingest = new FakeStreamingProvider({
      signingKey: readPlaybackSigningKey({ NODE_ENV: 'test' }),
      clock: new FixedClock(NOW),
    });
    const serialised = JSON.stringify([
      run.snapshot,
      run.getUncommittedEvents(),
      runConsoleOf(run.snapshot, run.openIncident, ingest),
    ]);
    expect(serialised).not.toContain(key);
    expect(serialised).not.toContain(streamKeyDigestOf(key));
  });
});
