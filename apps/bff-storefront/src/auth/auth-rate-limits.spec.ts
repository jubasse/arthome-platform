import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import type { Requirement } from '@arthome/contracts/http';
import { storefrontApi } from '@arthome/contracts/storefront-api';
import { AuthRateLimit } from '@arthome/core';

import {
  authThrottlers,
  CAPS_OF_BUCKET,
  capsOfRoute,
  ThrottleRule,
  type AuthRateLimitName,
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

describe('the caps a route declares', () => {
  const todaysCaps: Record<string, readonly AuthRateLimitName[]> = {
    signUp: ['SIGN_UP_PER_ADDRESS'],
    signIn: ['SIGN_IN_PER_ADDRESS', 'SIGN_IN_PER_EMAIL'],
    signOut: [],
    confirmEmailVerification: ['EMAIL_VERIFICATION_CONFIRM_PER_ADDRESS'],
    resendEmailVerification: [
      'EMAIL_VERIFICATION_RESEND_PER_ACCOUNT',
      'EMAIL_VERIFICATION_RESEND_PER_ACCOUNT_DAILY',
    ],
  };

  it.each(Object.entries(todaysCaps))(
    'are, on %s, the caps the route counted before',
    (id, caps) => {
      expect(capsOfRoute(storefrontApi.routes[id as keyof typeof storefrontApi.routes])).toEqual(
        caps,
      );
    },
  );

  it('count against nothing on a route that declares no throttle', () => {
    expect(capsOfRoute(storefrontApi.routes.getDateDetail)).toEqual([]);
  });

  it('are named by every cap of core, each under its own bucket', () => {
    for (const name of Object.keys(AuthRateLimit)) {
      expect(CAPS_OF_BUCKET[name]).toEqual([name]);
    }
  });
});

describe('the throttle rule', () => {
  const throttle = new ThrottleRule();
  const ruleOf = (bucket: string): Requirement =>
    ({ name: 'throttle', params: { bucket } }) as unknown as Requirement;

  it('binds a bucket that holds a cap', () => {
    expect(throttle.problemWith(ruleOf('SIGN_IN_PER_EMAIL'))).toBeUndefined();
  });

  it('refuses at boot a bucket that holds none, rather than let its route go uncounted', () => {
    expect(throttle.problemWith(ruleOf('password-reset'))).toBe('no cap named password-reset');
  });
});
