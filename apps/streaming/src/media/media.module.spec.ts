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
import { MediaModule, mediaProviderOutsideProduction } from './media.module.js';
import { CLOCK } from '../clock.js';
import { MEDIAMTX_SPEC_ENV } from './mediamtx/mediamtx-env-fixtures.js';
import { MediaMtxStreamingProvider } from './mediamtx/mediamtx-streaming-provider.js';

const clock = new FixedClock('2026-10-06T19:00:00.000Z');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('MediaModule', () => {
  it('binds the fake by default and MediaMTX when selected', () => {
    expect(mediaProviderOutsideProduction(clock, { NODE_ENV: 'test' })).toBeInstanceOf(
      FakeStreamingProvider,
    );
    expect(
      mediaProviderOutsideProduction(clock, { NODE_ENV: 'test', ...MEDIAMTX_SPEC_ENV }),
    ).toBeInstanceOf(MediaMtxStreamingProvider);
  });

  it('refuses either provider in production', async () => {
    for (const selected of ['fake', 'mediamtx']) {
      expect(() =>
        mediaProviderOutsideProduction(clock, {
          ...MEDIAMTX_SPEC_ENV,
          NODE_ENV: 'production',
          STREAMING_MEDIA_PROVIDER: selected,
        }),
      ).toThrow(`MediaModule: the ${selected} streaming provider cannot be bound in production`);
    }

    vi.stubEnv('NODE_ENV', 'production');
    await expect(Test.createTestingModule({ imports: [MediaModule] }).compile()).rejects.toThrow(
      /cannot be bound in production/,
    );
  });

  it('fails the boot on a missing MediaMTX URL or an unknown provider', () => {
    const { MEDIAMTX_EDGE_API_URL: _missing, ...withoutEdge } = MEDIAMTX_SPEC_ENV;
    expect(() =>
      mediaProviderOutsideProduction(clock, { NODE_ENV: 'test', ...withoutEdge }),
    ).toThrow(/MEDIAMTX_EDGE_API_URL/);
    expect(() =>
      mediaProviderOutsideProduction(clock, { NODE_ENV: 'test', STREAMING_MEDIA_PROVIDER: 'cdn' }),
    ).toThrow(/STREAMING_MEDIA_PROVIDER/);
  });

  it('resolves no fake when MediaMTX is bound, the four ports on one instance', async () => {
    for (const [name, value] of Object.entries(MEDIAMTX_SPEC_ENV)) vi.stubEnv(name, value);
    const moduleRef = await Test.createTestingModule({ imports: [MediaModule] }).compile();
    const provider = moduleRef.get<symbol, unknown>(LIVE_INGEST_PROVIDER);

    expect(provider).toBeInstanceOf(MediaMtxStreamingProvider);
    for (const token of [PLAYBACK_PROVIDER, RECORDING_PROVIDER, STREAMING_METRICS_PROVIDER]) {
      expect(moduleRef.get(token)).toBe(provider);
    }
    expect(moduleRef.get(FakeStreamingProvider)).toBeNull();
    await moduleRef.close();
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
