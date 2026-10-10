import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ApiErrorCode, InternalTokenIssuer } from '@arthome/core';

import { assertSameCaller, profileOfPrincipal, type Principal } from './principal.js';
import { RefusalException } from './refusal.js';

const PROFILE = '01a0e700-0000-7000-8000-0000000000d1';
const OTHER_PROFILE = '01a0e700-0000-7000-8000-0000000000d2';
const DEVICE = '01a0e700-0000-7000-8000-0000000000e1';
const OTHER_DEVICE = '01a0e700-0000-7000-8000-0000000000e2';

const principal: Principal = {
  accountId: '01a0e700-0000-7000-8000-0000000000c1',
  profileId: PROFILE,
  deviceId: DEVICE,
  issuer: InternalTokenIssuer.STOREFRONT_BFF,
};

function refusalOfCall(call: () => unknown): RefusalException {
  try {
    call();
  } catch (error) {
    if (error instanceof RefusalException) return error;
    throw error;
  }
  throw new Error('the call did not refuse');
}

function expectForbidden(call: () => unknown): void {
  const refusal = refusalOfCall(call);

  expect(refusal.getStatus()).toBe(HttpStatus.FORBIDDEN);
  expect(refusal.refusal.code).toBe(ApiErrorCode.FORBIDDEN);
}

describe('profileOfPrincipal', () => {
  it('is the profile the token names', () => {
    expect(profileOfPrincipal(principal)).toBe(PROFILE);
  });

  it('refuses 403 a token naming no profile', () => {
    expectForbidden(() => profileOfPrincipal({ ...principal, profileId: null }));
  });
});

describe('assertSameCaller', () => {
  it('passes a body naming the token profile and device, or neither', () => {
    expect(() =>
      assertSameCaller(principal, { profileId: PROFILE, deviceId: DEVICE }),
    ).not.toThrow();
    expect(() => assertSameCaller(principal, {})).not.toThrow();
  });

  it('refuses 403 a body profileId that differs', () => {
    expectForbidden(() => assertSameCaller(principal, { profileId: OTHER_PROFILE }));
  });

  it('refuses 403 a body deviceId that differs, even when the profile matches', () => {
    expectForbidden(() =>
      assertSameCaller(principal, { profileId: PROFILE, deviceId: OTHER_DEVICE }),
    );
  });

  it('refuses 403 a body naming what the token does not', () => {
    expectForbidden(() =>
      assertSameCaller({ ...principal, profileId: null }, { profileId: PROFILE }),
    );
    expectForbidden(() => assertSameCaller({ ...principal, deviceId: null }, { deviceId: DEVICE }));
  });
});
