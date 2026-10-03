import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { AllowAnonymous } from './allow-anonymous.js';
import type { InternalTokenVerifier } from './internal-token.verifier.js';
import { attachPrincipal, unauthenticated } from './principal.js';

const BEARER = /^Bearer ([A-Za-z0-9._-]+)$/;

/**
 * Every route needs the BFF's internal token (critical rule 4), unless `AllowAnonymous` exempts it.
 *   HTTP only: these services serve nothing else, and an unknown context is refused rather than
 *   waved through.
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  public constructor(
    private readonly verifier: InternalTokenVerifier,
    private readonly reflector: Reflector,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride(AllowAnonymous, [context.getHandler(), context.getClass()])
    ) {
      return true;
    }
    if (context.getType() !== 'http') throw unauthenticated();

    const request = context
      .switchToHttp()
      .getRequest<{ readonly headers: Readonly<Record<string, string | string[] | undefined>> }>();
    const header = request.headers.authorization;
    const token = typeof header === 'string' ? BEARER.exec(header)?.[1] : undefined;
    if (token === undefined) throw unauthenticated();

    attachPrincipal(request, await this.verifier.verify(token));
    return true;
  }
}
