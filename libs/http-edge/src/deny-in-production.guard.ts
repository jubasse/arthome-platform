import { HttpStatus, Injectable, type CanActivate } from '@nestjs/common';

import { ApiErrorCode, FailureNature } from '@arthome/core';

import { RefusalException } from './refusal.js';

/**
 * Refuses every request when the service runs in production.
 *
 * ⚠ NOT AUTHENTICATION, AND NOT A STAND-IN FOR IT. `adr-auth.md` defers
 *   authentication and that is not reopened. What is fixed is narrower and deferred
 *   by nothing: every write route in this repository binds on `0.0.0.0` with no
 *   guard, so it SHIPS REACHABLE — anyone who can route a packet to the port can
 *   create an account or publish a show for any channel. critical-rules #5 forbids
 *   the alternative argument, "only the BFF calls me".
 *
 * ⚠ IT COSTS THE WALKTHROUGH NOTHING: `AGENTS.md`'s event path runs under
 *   `development` and the tests under `test`. Only the environment where losing the
 *   route is the point loses it.
 *
 * ⚠ IT TAKES A BOOLEAN, NOT THE ENVIRONMENT. Which environment counts as production
 *   is `@arthome-platform/config`'s to decide, once, at startup; a guard reading
 *   `process.env` would be the second read `env.ts` warns against and untestable
 *   without mutating the process.
 */
@Injectable()
export class DenyInProductionGuard implements CanActivate {
  public constructor(private readonly isProduction: boolean) {}

  public canActivate(): boolean {
    if (!this.isProduction) {
      return true;
    }
    // ⚠ THROWN, NOT `return false`. A `false` yields NestJS's own 403 with an
    //   English message and no code, which critical-rules #8 forbids;
    //   `nestjs-request-pipeline` rule 11 is the same point from the other side.
    throw new RefusalException(HttpStatus.FORBIDDEN, {
      code: ApiErrorCode.FORBIDDEN,
      // No parameters: naming the environment, the route or the missing mechanism
      // tells an unauthenticated caller about the deployment.
      params: {},
      nature: FailureNature.REFUSED,
    });
  }
}
