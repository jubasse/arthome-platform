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

/**
 * The fake accepts whatever its authorizer accepts and signs playback with a published key: bound
 *   in production, it would serve nothing real under a key anyone holds. So a production boot of
 *   anything that imports the media ports fails here.
 */
export function fakeOutsideProduction(
  clock: Clock,
  source: Record<string, string | undefined> = process.env,
): FakeStreamingProvider {
  if (isProductionEnvironment(source)) {
    throw new Error('MediaModule: the fake streaming provider cannot be bound in production');
  }
  return new FakeStreamingProvider({ signingKey: readPlaybackSigningKey(source), clock });
}

/** The four media ports, bound to the fake until a real provider's adapter replaces it here. */
@Module({
  providers: [
    { provide: CLOCK, useValue: new SystemClock() },
    {
      provide: FakeStreamingProvider,
      inject: [CLOCK],
      useFactory: (clock: Clock): FakeStreamingProvider => fakeOutsideProduction(clock),
    },
    { provide: LIVE_INGEST_PROVIDER, useExisting: FakeStreamingProvider },
    { provide: PLAYBACK_PROVIDER, useExisting: FakeStreamingProvider },
    { provide: RECORDING_PROVIDER, useExisting: FakeStreamingProvider },
    { provide: STREAMING_METRICS_PROVIDER, useExisting: FakeStreamingProvider },
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
