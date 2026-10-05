import type { ServerResponse } from 'node:http';

import { RefusalException, unauthenticated, type IdentityGuard } from '@arthome-platform/http-edge';
import { Inject, Injectable, type ExecutionContext } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import type { Route } from '@arthome/contracts/http';
import { SessionMode } from '@arthome/contracts/identity';
import type { Clock } from '@arthome/core';

import { cookieWriteNeedsCsrf, verifyCsrfToken } from './csrf.guard.js';
import { presentedSession, type CookieCarrier, type PresentedSession } from './session-carriers.js';
import { attachViewer } from './viewer.js';
import { CLOCK } from '../clock.js';
import { IdentityClient } from '../identity/identity.client.js';
import { SESSION_VALIDATION_BUDGET_MS, serviceCallFor } from '../upstream/service-call.js';

function refusedCredentialIsAnonymous(route: Route): boolean {
  return (
    route.access?.kind === 'identified' && route.access.refusedCredentialIsAnonymous !== undefined
  );
}

/**
 * The `viewer` identity: the session the request presents, by cookie or bearer token, resolved by
 *   identity ("the BFF, and it alone, validates the session", `adr-auth.md` §8). The viewer is
 *   also left on the request, for the caps that count by account.
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
    const presented = this.presentedBy(request, route);
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
    if (session === null) {
      if (refusedCredentialIsAnonymous(route)) return null;
      throw unauthenticated();
    }
    attachViewer(request, { ...session, ...presented });
    return session;
  }

  private presentedBy(request: CookieCarrier, route: Route): PresentedSession | null {
    try {
      return presentedSession(request);
    } catch (error) {
      if (error instanceof RefusalException && refusedCredentialIsAnonymous(route)) return null;
      throw error;
    }
  }
}
