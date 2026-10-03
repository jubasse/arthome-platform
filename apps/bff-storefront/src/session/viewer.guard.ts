import type { ServerResponse } from 'node:http';

import { unauthenticated } from '@arthome-platform/http-edge';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { Clock } from '@arthome/core';

import { presentedSession, type CookieCarrier } from './session-carriers.js';
import { RequiresViewer, attachViewer } from './viewer.js';
import { CLOCK } from '../clock.js';
import { IdentityClient } from '../identity/identity.client.js';
import { SESSION_VALIDATION_BUDGET_MS, serviceCallFor } from '../upstream/service-call.js';

/**
 * "The BFF, and it alone, validates the session" (`adr-auth.md` §8): on a route marked
 *   `RequiresViewer`, identity resolves the presented session before anything else runs. Elsewhere
 *   nothing is resolved, so a public read never waits on identity.
 */
@Injectable()
export class ViewerGuard implements CanActivate {
  public constructor(
    private readonly identity: IdentityClient,
    private readonly reflector: Reflector,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      !this.reflector.getAllAndOverride(RequiresViewer, [context.getHandler(), context.getClass()])
    ) {
      return true;
    }
    const http = context.switchToHttp();
    const request = http.getRequest<CookieCarrier>();
    const presented = presentedSession(request);
    if (presented === null) throw unauthenticated();

    const session = await this.identity.resolve(
      presented.token,
      serviceCallFor(
        request,
        http.getResponse<{ readonly raw: ServerResponse }>().raw,
        this.clock,
        SESSION_VALIDATION_BUDGET_MS,
        null,
      ),
    );
    if (session === null) throw unauthenticated();
    attachViewer(request, { ...session, ...presented });
    return true;
  }
}
