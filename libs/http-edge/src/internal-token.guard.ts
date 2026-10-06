import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { z } from 'zod';

import type { ServicePrincipalSchema } from '@arthome/contracts/http';

import { AllowAnonymous } from './allow-anonymous.js';
import { routeOf, type IdentityGuard } from './endpoint-access.js';
import { InternalTokenVerifier } from './internal-token.verifier.js';
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
    // `EndpointAccessGuard` applies the access a route declares, the `service` identity included.
    if (routeOf(this.reflector, context)?.access !== undefined) return true;
    if (context.getType() !== 'http') throw unauthenticated();

    const request = context.switchToHttp().getRequest<TokenCarrier>();
    const token = presentedInternalToken(request);
    if (token === null) throw unauthenticated();

    attachPrincipal(request, await this.verifier.verify(token));
    return true;
  }
}

interface TokenCarrier {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** The bearer token a request carries; null when it carries none, a 401 when it is not one. */
function presentedInternalToken(request: TokenCarrier): string | null {
  const header = request.headers.authorization;
  if (header === undefined) return null;
  const token = typeof header === 'string' ? BEARER.exec(header)?.[1] : undefined;
  if (token === undefined) throw unauthenticated();
  return token;
}

/**
 * Core's `service` identity (ADR contract model §9.1): the internal token a BFF mints for the end
 *   user, verified as `InternalTokenGuard` does. Its principal is core's, from the token's `iss`,
 *   `sub`, `pro` and `did`, a claim the token lacks absent rather than null; the verified claims
 *   are left where `principalOf` reads them too.
 */
@Injectable()
export class ServiceIdentity implements IdentityGuard {
  public constructor(private readonly verifier: InternalTokenVerifier) {}

  public async identify(
    context: ExecutionContext,
  ): Promise<z.output<typeof ServicePrincipalSchema> | null> {
    const request = context.switchToHttp().getRequest<TokenCarrier>();
    const token = presentedInternalToken(request);
    if (token === null) return null;
    const verified = await this.verifier.verify(token);
    attachPrincipal(request, verified);
    return {
      callingService: verified.issuer,
      userId: verified.accountId,
      ...(verified.profileId !== null && { profileId: verified.profileId }),
      ...(verified.deviceId !== null && { deviceId: verified.deviceId }),
    };
  }
}
