import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { ApiErrorCode, FailureNature } from '@arthome/core';

import { AllowInProduction } from './allow-in-production.js';
import { RefusalException } from './refusal.js';

/**
 * Refuses every request when the service runs in production.
 *
 * ⚠ Not authentication — `adr-auth.md` defers that. What is fixed is narrower: every write
 *   route here binds on `0.0.0.0` with no guard, so it SHIPS REACHABLE. critical-rules #5
 *   forbids the "only the BFF calls me" argument.
 * ⚠ It takes a boolean, not the environment: a guard reading `process.env` would be
 *   untestable without mutating the process.
 */
@Injectable()
export class DenyInProductionGuard implements CanActivate {
  public constructor(
    private readonly isProduction: boolean,
    private readonly reflector: Reflector,
  ) {}

  public canActivate(context: ExecutionContext): boolean {
    if (!this.isProduction) {
      return true;
    }
    if (
      this.reflector.getAllAndOverride(AllowInProduction, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }
    // ⚠ Thrown, not `return false`: a `false` yields NestJS's own 403 with an English message
    //   and no code, which critical-rules #8 forbids.
    throw new RefusalException(HttpStatus.FORBIDDEN, {
      code: ApiErrorCode.FORBIDDEN,
      // No parameters: naming the environment, the route or the missing mechanism tells an
      // unauthenticated caller about the deployment.
      params: {},
      nature: FailureNature.REFUSED,
    });
  }
}
