import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import type { Requirement } from '@arthome/contracts/http';
import { AuthRateLimit } from '@arthome/core';

import {
  authThrottlers,
  ThrottleRule,
  type AuthRateLimitName,
  type AuthThrottlerGuard,
} from './auth-rate-limits.js';

function limitOf(name: AuthRateLimitName, ip: string): unknown {
  const throttler = authThrottlers(new Reflector()).find((candidate) => candidate.name === name);
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ ip }) }),
  } as unknown as ExecutionContext;
  return typeof throttler?.limit === 'function' ? throttler.limit(context) : throttler?.limit;
}

describe('the per-address caps, by the caller’s address family', () => {
  it('give an IPv4 address, mapped or not, the high ceiling carriers sharing it need', () => {
    for (const ip of ['203.0.113.5', '::ffff:203.0.113.5']) {
      expect(limitOf('SIGN_IN_PER_ADDRESS', ip)).toBe(AuthRateLimit.SIGN_IN_PER_ADDRESS.ipv4Limit);
      expect(limitOf('SIGN_UP_PER_ADDRESS', ip)).toBe(AuthRateLimit.SIGN_UP_PER_ADDRESS.ipv4Limit);
    }
  });

  it('keep the tight limits on an IPv6 /64', () => {
    expect(limitOf('SIGN_IN_PER_ADDRESS', '2001:db8:1:2::7')).toBe(
      AuthRateLimit.SIGN_IN_PER_ADDRESS.limit,
    );
    expect(limitOf('SIGN_UP_PER_ADDRESS', '2001:db8:1:2::7')).toBe(
      AuthRateLimit.SIGN_UP_PER_ADDRESS.limit,
    );
  });

  it('leave a cap with no IPv4 ceiling at its one limit for both families', () => {
    const { limit } = AuthRateLimit.SIGN_IN_PER_EMAIL;
    expect(limitOf('SIGN_IN_PER_EMAIL', '203.0.113.5')).toBe(limit);
    expect(limitOf('SIGN_IN_PER_EMAIL', '2001:db8:1:2::7')).toBe(limit);
  });
});

describe('the auth bucket, until core names one cap per bucket', () => {
  const rule = { name: 'throttle', params: { bucket: 'auth' } } as unknown as Requirement;
  // The auth bucket never reaches the throttler: the caps the route names are counted globally.
  const throttle = new ThrottleRule(undefined as unknown as AuthThrottlerGuard, new Reflector());

  it('binds at boot, leaving the count to the caps the route names', () => {
    expect(throttle.problemWith(rule)).toBeUndefined();
  });

  it('refuses a route that names no cap rather than let it through uncounted', () => {
    const unnamed = (): undefined => undefined;
    const context = {
      getHandler: () => unnamed,
      getClass: () => Object,
    } as unknown as ExecutionContext;

    expect(() => throttle.check(context, rule)).toThrow(
      'A route throttled by the auth bucket names no cap.',
    );
  });
});
