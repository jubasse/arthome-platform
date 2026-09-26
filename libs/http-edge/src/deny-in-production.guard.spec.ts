import { HttpStatus, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { ApiErrorCode, FailureNature } from '@arthome/core';

import { AllowInProduction } from './allow-in-production.js';
import { DenyInProductionGuard } from './deny-in-production.guard.js';
import { RefusalException } from './refusal.js';

class WriteRoutes {
  public register(): string {
    return 'register';
  }
}

@AllowInProduction()
class Probes {
  public liveness(): string {
    return 'liveness';
  }
}

class MixedRoutes {
  @AllowInProduction()
  public readiness(): string {
    return 'readiness';
  }

  public publish(): string {
    return 'publish';
  }
}

function contextFor(controller: new () => object, handler: string): ExecutionContext {
  const handlerFn = (controller.prototype as Record<string, () => void>)[handler];
  return {
    getHandler: () => handlerFn,
    getClass: () => controller,
  } as unknown as ExecutionContext;
}

const reflector = new Reflector();

describe('DenyInProductionGuard', () => {
  it('lets every route through outside production', () => {
    const guard = new DenyInProductionGuard(false, reflector);
    expect(guard.canActivate(contextFor(WriteRoutes, 'register'))).toBe(true);
  });

  /** ⚠ Not authentication: every write route binds on 0.0.0.0 unguarded, so it ships reachable. */
  it('refuses an unexempted route in production', () => {
    const guard = new DenyInProductionGuard(true, reflector);
    expect(() => guard.canActivate(contextFor(WriteRoutes, 'register'))).toThrow(RefusalException);
  });

  it('refuses with a code and a status, never a sentence', () => {
    const guard = new DenyInProductionGuard(true, reflector);
    let thrown: unknown;
    try {
      guard.canActivate(contextFor(WriteRoutes, 'register'));
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RefusalException);
    if (!(thrown instanceof RefusalException)) return;
    expect(thrown.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(thrown.refusal).toEqual({
      code: ApiErrorCode.FORBIDDEN,
      params: {},
      nature: FailureNature.REFUSED,
    });
  });

  it('lets an exempted controller through in production', () => {
    const guard = new DenyInProductionGuard(true, reflector);
    expect(guard.canActivate(contextFor(Probes, 'liveness'))).toBe(true);
  });

  it('reads the exemption per handler, and it does not leak to a sibling', () => {
    const guard = new DenyInProductionGuard(true, reflector);
    expect(guard.canActivate(contextFor(MixedRoutes, 'readiness'))).toBe(true);
    expect(() => guard.canActivate(contextFor(MixedRoutes, 'publish'))).toThrow(RefusalException);
  });
});
