import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  DiscoveryService,
  HttpAdapterHost,
  MetadataScanner,
  Reflector,
} from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { Service, SystemClock } from '@arthome/core';

import { edgeProviders } from './edge-providers.js';
import { ENDPOINT_GUARDS, EndpointGuardsCheck } from './endpoint-access.js';
import { InternalTokenVerifier } from './internal-token.verifier.js';
import { JsonBodiesOnly } from './json-bodies-only.js';

const CLOCK = Symbol('Clock');

interface BoundProvider {
  readonly provide: unknown;
  readonly inject?: readonly unknown[];
  readonly useValue?: unknown;
}

const bound = edgeProviders({ service: Service.CATALOG, clock: CLOCK }).map((provider) =>
  typeof provider === 'function' ? { provide: provider } : provider,
) as BoundProvider[];
const providerOf = (token: unknown): BoundProvider | undefined =>
  bound.filter(({ provide }) => provide === token).at(-1);

describe('edgeProviders', () => {
  it('binds each global enhancer once, and the system clock under the service’s token', () => {
    expect(bound.map(({ provide }) => provide)).toEqual([
      ENDPOINT_GUARDS,
      APP_GUARD,
      APP_INTERCEPTOR,
      DiscoveryService,
      MetadataScanner,
      EndpointGuardsCheck,
      APP_PIPE,
      APP_FILTER,
      APP_INTERCEPTOR,
      InternalTokenVerifier,
      APP_GUARD,
      APP_GUARD,
      CLOCK,
      JsonBodiesOnly,
    ]);
    expect(providerOf(CLOCK)?.useValue).toBeInstanceOf(SystemClock);
  });

  it('hands both envelopes the clock the service’s modules inject, which a suite overrides', () => {
    expect(providerOf(APP_FILTER)?.inject).toEqual([HttpAdapterHost, CLOCK]);
    expect(providerOf(APP_INTERCEPTOR)?.inject).toEqual([CLOCK]);
  });

  it('verifies the internal token before refusing what no slice authorises yet', () => {
    const guards = bound.filter(({ provide }) => provide === APP_GUARD).slice(1);
    expect(guards.map(({ inject }) => inject)).toEqual([
      [InternalTokenVerifier, Reflector],
      [Reflector],
    ]);
    expect(providerOf(InternalTokenVerifier)?.inject).toEqual([CLOCK]);
  });
});
