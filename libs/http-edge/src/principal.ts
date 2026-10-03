import { HttpStatus, createParamDecorator, type ExecutionContext } from '@nestjs/common';

import { ApiErrorCode, FailureNature, type InternalTokenIssuer } from '@arthome/core';

import { RefusalException } from './refusal.js';

/** Who a service is serving, as the BFF's verified internal token says (`adr-auth.md` §8). */
export interface Principal {
  /** Null for an anonymous visitor: a public read, a sign-up. */
  readonly accountId: string | null;
  readonly profileId: string | null;
  readonly deviceId: string | null;
  readonly issuer: InternalTokenIssuer;
}

const principals = new WeakMap<object, Principal>();

export function attachPrincipal(request: object, principal: Principal): void {
  principals.set(request, principal);
}

/** Null on a route `AllowAnonymous` exempts, the only routes the guard lets through without one. */
export function principalOf(request: object): Principal | null {
  return principals.get(request) ?? null;
}

export function unauthenticated(): RefusalException {
  return new RefusalException(HttpStatus.UNAUTHORIZED, {
    code: ApiErrorCode.UNAUTHENTICATED,
    params: {},
    nature: FailureNature.REFUSED,
  });
}

/** The account the call is made for, or a 401: the route serves no anonymous visitor. */
export function accountOf(principal: Principal | null): string {
  if (principal?.accountId == null) throw unauthenticated();
  return principal.accountId;
}

/** The verified caller of a route the internal token's guard covers. */
export const CurrentPrincipal: () => ParameterDecorator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const principal = principalOf(context.switchToHttp().getRequest<object>());
    if (principal === null) throw unauthenticated();
    return principal;
  },
);
