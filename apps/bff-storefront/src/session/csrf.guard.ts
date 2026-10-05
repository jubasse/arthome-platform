import { RefusalException, refusalOf, routeOf } from '@arthome-platform/http-edge';
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { HttpAdapterHost, Reflector } from '@nestjs/core';

import type { Route, SecurityRequirement } from '@arthome/contracts/http';
import { ApiErrorCode } from '@arthome/core';

import { SESSION_COOKIE, type CookieCarrier } from './session-carriers.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface CsrfProtecting {
  csrfProtection(request: unknown, reply: unknown, next: () => void): void;
}

function csrfRefused(): RefusalException {
  return refusalOf(ApiErrorCode.FORBIDDEN);
}

/**
 * A write by the session cookie must carry the CSRF token when the identity's write schemes pair
 *   them, unless the route declares `csrfExempt` (sign-out: a forged one grants nothing, and a
 *   browser that lost its secret must still be able to leave).
 */
export function cookieWriteNeedsCsrf(route: Route): boolean {
  if (route.method === 'get' || route.access?.kind !== 'identified') return false;
  if (route.access.csrfExempt !== undefined) return false;
  return route.access.identity.schemes.write.some(
    (scheme: SecurityRequirement) => 'sessionCookie' in scheme && 'csrfToken' in scheme,
  );
}

/**
 * Every request that writes with the session cookie carries its CSRF token (storefront.yaml
 *   `sessionCookie`, `nestjs-web-security` rule 4), checked by `@fastify/csrf-protection` itself.
 *   A guard rather than the plugin's own hook: the plugin answers a refusal with Fastify's error
 *   body, and this one leaves through the error envelope (critical rule 8). A request without the
 *   cookie carries no ambient credential, so it has nothing to forge. What is exempt is the
 *   route's contract to say: a public route opens a session rather than using one, and
 *   `csrfExempt` names the rest. `ViewerIdentity` checks the same token where it resolves the
 *   session; this guard is the second line.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  public constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly reflector: Reflector,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<CookieCarrier & { readonly method: string }>();
    if (SAFE_METHODS.has(request.method)) return true;
    const route = routeOf(this.reflector, context);
    if (route?.access !== undefined && !cookieWriteNeedsCsrf(route)) return true;
    if (!request.cookies?.[SESSION_COOKIE]) return true;

    await verifyCsrfToken(this.adapterHost, context);
    return true;
  }
}

/** The token a cookie write carries, checked by `@fastify/csrf-protection` against its session. */
export async function verifyCsrfToken(
  adapterHost: HttpAdapterHost,
  context: ExecutionContext,
): Promise<void> {
  const http = context.switchToHttp();
  const fastify = adapterHost.httpAdapter.getInstance<CsrfProtecting>();
  const reply = http.getResponse<object>();
  await new Promise<void>((resolve, reject) => {
    // The plugin answers a refusal by sending its own error: here it rejects instead.
    const refusing = Object.create(reply, {
      send: { value: () => reject(csrfRefused()) },
    }) as object;
    fastify.csrfProtection(http.getRequest<object>(), refusing, resolve);
  });
}
