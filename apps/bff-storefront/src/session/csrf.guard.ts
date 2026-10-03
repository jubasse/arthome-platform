import { RefusalException } from '@arthome-platform/http-edge';
import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { HttpAdapterHost, Reflector, type ReflectableDecorator } from '@nestjs/core';

import { ApiErrorCode, FailureNature } from '@arthome/core';

import { SESSION_COOKIE, type CookieCarrier } from './session-carriers.js';

/** Marks a route that opens a session rather than using one: sign-up, sign-in, the email link. */
export const OpensNoSession: ReflectableDecorator<void, true> = Reflector.createDecorator<
  void,
  true
>({ transform: () => true });

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface CsrfProtecting {
  csrfProtection(request: unknown, reply: unknown, next: () => void): void;
}

function csrfRefused(): RefusalException {
  return new RefusalException(HttpStatus.FORBIDDEN, {
    code: ApiErrorCode.FORBIDDEN,
    params: {},
    nature: FailureNature.REFUSED,
  });
}

/**
 * Every request that writes with the session cookie carries its CSRF token (storefront.yaml
 *   `sessionCookie`, `nestjs-web-security` rule 4), checked by `@fastify/csrf-protection` itself.
 *   A guard rather than the plugin's own hook: the plugin answers a refusal with Fastify's error
 *   body, and this one leaves through the error envelope (critical rule 8). A request without the
 *   cookie carries no ambient credential, so it has nothing to forge.
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
    if (
      this.reflector.getAllAndOverride(OpensNoSession, [context.getHandler(), context.getClass()])
    ) {
      return true;
    }
    if (!request.cookies?.[SESSION_COOKIE]) return true;

    const fastify = this.adapterHost.httpAdapter.getInstance<CsrfProtecting>();
    const reply = http.getResponse<object>();
    await new Promise<void>((resolve, reject) => {
      // The plugin answers a refusal by sending its own error: here it rejects instead.
      const refusing = Object.create(reply, {
        send: { value: () => reject(csrfRefused()) },
      }) as object;
      fastify.csrfProtection(request, refusing, resolve);
    });
    return true;
  }
}
