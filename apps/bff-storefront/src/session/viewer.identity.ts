import type { ServerResponse } from 'node:http';

import { unauthenticated, type IdentityGuard } from '@arthome-platform/http-edge';
import { Inject, Injectable, type ExecutionContext } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import type { Route, SecurityRequirement } from '@arthome/contracts/http';
import { SessionMode } from '@arthome/contracts/identity';
import type { Clock } from '@arthome/core';

import { verifyCsrfToken } from './csrf.guard.js';
import { presentedSession, type CookieCarrier } from './session-carriers.js';
import { attachViewer } from './viewer.js';
import { CLOCK } from '../clock.js';
import { IdentityClient } from '../identity/identity.client.js';
import { SESSION_VALIDATION_BUDGET_MS, serviceCallFor } from '../upstream/service-call.js';

/** A write by the session cookie must carry the CSRF token when the identity's write schemes pair them. */
function cookieWriteNeedsCsrf(route: Route): boolean {
  if (route.method === 'get' || route.access?.kind !== 'identified') return false;
  return route.access.identity.schemes.write.some(
    (scheme: SecurityRequirement) => 'sessionCookie' in scheme && 'csrfToken' in scheme,
  );
}

/**
 * The `viewer` identity: the session the request presents, by cookie or bearer token, resolved by
 *   identity ("the BFF, and it alone, validates the session", `adr-auth.md` §8). The viewer is
 *   also left where `ViewerGuard` leaves it, for the caps that count by account.
 */
@Injectable()
export class ViewerIdentity implements IdentityGuard {
  public constructor(
    private readonly identity: IdentityClient,
    private readonly adapterHost: HttpAdapterHost,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async identify(context: ExecutionContext, route: Route): Promise<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<CookieCarrier>();
    const presented = presentedSession(request);
    if (presented === null) return null;
    if (presented.carrier === SessionMode.COOKIE && cookieWriteNeedsCsrf(route)) {
      await verifyCsrfToken(this.adapterHost, context);
    }

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
    return session;
  }
}
