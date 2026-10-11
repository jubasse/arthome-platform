import { refusalOf, type Principal } from '@arthome-platform/http-edge';

import { InternalTokenIssuer, ApiErrorCode } from '@arthome/core';

/** The verified service principal of a storefront BFF call, as the routes' `HandlerInput` types it. */
export interface ServicePrincipal {
  readonly userId: string | null;
  readonly profileId?: string | null | undefined;
  readonly deviceId?: string | null | undefined;
}

/** A 403 without a user: playback and progress are always an account's, as the run desk is an operator's. */
export function accountOf(principal: ServicePrincipal): string {
  if (principal.userId === null) throw refusalOf(ApiErrorCode.FORBIDDEN);
  return principal.userId;
}

/** http-edge's caller, a claim the token lacks read as null. */
export function callerOf(principal: ServicePrincipal): Principal {
  return {
    accountId: principal.userId,
    profileId: principal.profileId ?? null,
    deviceId: principal.deviceId ?? null,
    issuer: InternalTokenIssuer.STOREFRONT_BFF,
  };
}
