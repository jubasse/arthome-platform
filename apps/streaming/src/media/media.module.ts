import { isProductionEnvironment, readPlaybackSigningKey } from '@arthome-platform/config';
import { Module } from '@nestjs/common';

import { SystemClock, type Clock } from '@arthome/core';

import { FakeStreamingProvider } from './fake-streaming-provider.js';
import {
  LIVE_INGEST_PROVIDER,
  PLAYBACK_PROVIDER,
  RECORDING_PROVIDER,
  STREAMING_METRICS_PROVIDER,
} from './media-tokens.js';
import { CLOCK } from '../clock.js';
import {
  StreamingMediaProvider,
  readMediaMtxEnv,
  readStreamingMediaProvider,
} from './mediamtx/mediamtx-env.js';
import { MediaMtxStreamingProvider } from './mediamtx/mediamtx-streaming-provider.js';

const SELECTED_MEDIA_PROVIDER: unique symbol = Symbol('SelectedMediaProvider');

/**
 * Both providers are refused in production: the fake accepts whatever its authorizer accepts, and
 *   both sign playback with a key whose published development value is their default. So a
 *   production boot of anything that imports the media ports fails here until a real CDN's
 *   provider is bound.
 */
export function mediaProviderOutsideProduction(
  clock: Clock,
  source: Record<string, string | undefined> = process.env,
): FakeStreamingProvider | MediaMtxStreamingProvider {
  const selected = readStreamingMediaProvider(source);
  if (isProductionEnvironment(source)) {
    throw new Error(
      `MediaModule: the ${selected} streaming provider cannot be bound in production`,
    );
  }
  const signingKey = readPlaybackSigningKey(source);
  return selected === StreamingMediaProvider.MEDIAMTX
    ? new MediaMtxStreamingProvider({ env: readMediaMtxEnv(source), signingKey, clock })
    : new FakeStreamingProvider({ signingKey, clock });
}

/**
 * The four media ports on one provider, chosen by `STREAMING_MEDIA_PROVIDER` (the fake by default).
 *   `FakeStreamingProvider` resolves to null when MediaMTX is bound: the suites drive the fake.
 */
@Module({
  providers: [
    { provide: CLOCK, useValue: new SystemClock() },
    {
      provide: SELECTED_MEDIA_PROVIDER,
      inject: [CLOCK],
      useFactory: (clock: Clock) => mediaProviderOutsideProduction(clock),
    },
    {
      provide: FakeStreamingProvider,
      inject: [SELECTED_MEDIA_PROVIDER],
      useFactory: (provider: FakeStreamingProvider | MediaMtxStreamingProvider) =>
        provider instanceof FakeStreamingProvider ? provider : null,
    },
    { provide: LIVE_INGEST_PROVIDER, useExisting: SELECTED_MEDIA_PROVIDER },
    { provide: PLAYBACK_PROVIDER, useExisting: SELECTED_MEDIA_PROVIDER },
    { provide: RECORDING_PROVIDER, useExisting: SELECTED_MEDIA_PROVIDER },
    { provide: STREAMING_METRICS_PROVIDER, useExisting: SELECTED_MEDIA_PROVIDER },
  ],
  exports: [
    LIVE_INGEST_PROVIDER,
    PLAYBACK_PROVIDER,
    RECORDING_PROVIDER,
    STREAMING_METRICS_PROVIDER,
    FakeStreamingProvider,
  ],
})
export class MediaModule {}
