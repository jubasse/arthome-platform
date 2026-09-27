import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE, HttpAdapterHost } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { SystemClock } from '@arthome/core';

import { edgeProviders } from './edge-providers.js';

const CLOCK = Symbol('Clock');

interface BoundProvider {
  readonly provide: unknown;
  readonly inject?: readonly unknown[];
  readonly useValue?: unknown;
}

const bound = edgeProviders({ clock: CLOCK }) as BoundProvider[];
const providerOf = (token: unknown): BoundProvider | undefined =>
  bound.find(({ provide }) => provide === token);

describe('edgeProviders', () => {
  it('binds each global enhancer once, and the system clock under the service’s token', () => {
    expect(bound.map(({ provide }) => provide)).toEqual([
      APP_PIPE,
      APP_FILTER,
      APP_INTERCEPTOR,
      APP_GUARD,
      CLOCK,
    ]);
    expect(providerOf(CLOCK)?.useValue).toBeInstanceOf(SystemClock);
  });

  it('hands both envelopes the clock the service’s modules inject, which a suite overrides', () => {
    expect(providerOf(APP_FILTER)?.inject).toEqual([HttpAdapterHost, CLOCK]);
    expect(providerOf(APP_INTERCEPTOR)?.inject).toEqual([CLOCK]);
  });
});
