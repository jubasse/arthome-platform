import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ApiErrorCode, FailureNature } from '@arthome/core';

import { DenyInProductionGuard } from './deny-in-production.guard.js';
import { RefusalException } from './refusal.js';

describe('DenyInProductionGuard', () => {
  it('lets the request through where the route is meant to be reachable', () => {
    // `AGENTS.md`'s walkthrough and the test suite both run here, and neither may
    // lose the route: a guard that broke the documented walkthrough would be
    // removed by the next person rather than understood.
    expect(new DenyInProductionGuard(false).canActivate()).toBe(true);
  });

  it('refuses in production, so the unauthenticated write route does not ship reachable', () => {
    // This is not authentication — `adr-auth.md` defers that and it is not
    // reopened. It is that every write route binds on 0.0.0.0 with no guard, so
    // anyone who can route a packet to the port can create an account or publish a
    // show. critical-rules #5 forbids the argument that would excuse it, "only the
    // BFF calls me".
    expect(() => new DenyInProductionGuard(true).canActivate()).toThrow(RefusalException);
  });

  it('refuses with a code and a status, never a sentence', () => {
    let thrown: unknown;
    try {
      new DenyInProductionGuard(true).canActivate();
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RefusalException);
    if (!(thrown instanceof RefusalException)) {
      return;
    }
    // 403 and not 401: there are no credentials to be missing. A `return false`
    // would also yield 403, but with NestJS's English message and no code.
    expect(thrown.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(thrown.refusal.code).toBe(ApiErrorCode.FORBIDDEN);
    expect(thrown.refusal.nature).toBe(FailureNature.REFUSED);
    // Nothing about the environment, the route or the missing mechanism: an
    // unauthenticated caller is entitled to the refusal and to nothing else.
    expect(thrown.refusal.params).toEqual({});
  });
});
