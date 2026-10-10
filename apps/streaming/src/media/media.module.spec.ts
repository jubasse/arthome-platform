import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FixedClock } from '@arthome/core';

import { FakeStreamingProvider } from './fake-streaming-provider.js';
import { IngestProtocol } from './media-ports.js';
import {
  LIVE_INGEST_PROVIDER,
  PLAYBACK_PROVIDER,
  RECORDING_PROVIDER,
  STREAMING_METRICS_PROVIDER,
} from './media-tokens.js';
import { MediaModule, fakeOutsideProduction } from './media.module.js';
import { CLOCK } from '../clock.js';

const clock = new FixedClock('2026-10-06T19:00:00.000Z');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('MediaModule', () => {
  it('refuses to bind the fake in production', async () => {
    expect(() => fakeOutsideProduction(clock, { NODE_ENV: 'production' })).toThrow(
      'MediaModule: the fake streaming provider cannot be bound in production',
    );

    vi.stubEnv('NODE_ENV', 'production');
    await expect(Test.createTestingModule({ imports: [MediaModule] }).compile()).rejects.toThrow(
      /cannot be bound in production/,
    );
  });

  it('binds the four ports to one fake, on the clock a suite overrides', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [MediaModule] })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .compile();
    const fake = moduleRef.get(FakeStreamingProvider);
    const online: string[] = [];
    fake.attachIngestHooks({
      authorizer: { authorize: () => Promise.resolve({ accepted: true }) },
      listener: {
        publisherOnline: ({ at }) => {
          online.push(at);
          return Promise.resolve();
        },
        publisherOffline: () => Promise.resolve(),
        workerFailed: () => Promise.resolve(),
      },
    });
    await fake.publish('a1b2c3', 'key', { protocol: IngestProtocol.RTMPS });

    expect(fake).toBeInstanceOf(FakeStreamingProvider);
    for (const token of [
      LIVE_INGEST_PROVIDER,
      PLAYBACK_PROVIDER,
      RECORDING_PROVIDER,
      STREAMING_METRICS_PROVIDER,
    ]) {
      expect(moduleRef.get(token)).toBe(fake);
    }
    expect(online).toEqual([clock.now()]);
    await moduleRef.close();
  });
});
