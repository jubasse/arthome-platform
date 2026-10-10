import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import { ApiErrorCode, type InternalTokenIssuer } from '@arthome/core';

import type { RefusalException } from './refusal.js';
import { refusalOf } from './refusal.js';

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
  return refusalOf(ApiErrorCode.UNAUTHENTICATED);
}

/** The account the call is made for, or a 401: the route serves no anonymous visitor. */
export function accountOf(principal: Principal | null): string {
  if (principal?.accountId == null) throw unauthenticated();
  return principal.accountId;
}

/** The profile the token names, or a 403: the route reads a profile and the token carries none. */
export function profileOfPrincipal(principal: Principal): string {
  if (principal.profileId === null) throw refusalOf(ApiErrorCode.FORBIDDEN);
  return principal.profileId;
}

/**
 * A body naming a `profileId` or `deviceId` other than the token's is refused 403: the BFF vouches
 * for the caller in the token, so the body cannot pick another profile of the account.
 */
export function assertSameCaller(
  principal: Principal,
  body: { readonly profileId?: string; readonly deviceId?: string },
): void {
  if (body.profileId !== undefined && body.profileId !== principal.profileId) {
    throw refusalOf(ApiErrorCode.FORBIDDEN);
  }
  if (body.deviceId !== undefined && body.deviceId !== principal.deviceId) {
    throw refusalOf(ApiErrorCode.FORBIDDEN);
  }
}

/** The verified caller of a route the internal token's guard covers. */
export const CurrentPrincipal: () => ParameterDecorator = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const principal = principalOf(context.switchToHttp().getRequest<object>());
    if (principal === null) throw unauthenticated();
    return principal;
  },
);
