import { isIPv4 } from 'node:net';

import { RefusalException } from '@arthome-platform/http-edge';
import { HttpStatus, Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector, type ReflectableDecorator } from '@nestjs/core';
import {
  DEFAULT_IPV6_SUBNET_PREFIX,
  ThrottlerGuard,
  normalizeIp,
  seconds,
  type ThrottlerLimitDetail,
  type ThrottlerOptions,
} from '@nestjs/throttler';

import { ApiErrorCode, AuthRateLimit, FailureNature, limitForAddress } from '@arthome/core';

import { viewerOf } from '../session/viewer.js';

export type AuthRateLimitName = keyof typeof AuthRateLimit;

/** The caps a route counts against, by their name in core's `AuthRateLimit`. */
export const RateLimitedBy: ReflectableDecorator<
  readonly AuthRateLimitName[],
  readonly AuthRateLimitName[]
> = Reflector.createDecorator<readonly AuthRateLimitName[]>();

interface TrackedRequest {
  readonly ip: string;
  readonly body?: unknown;
}

/** The address as identity matches it, so `A@x` and `a@x ` count as one. */
export function normalisedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function emailOf(request: TrackedRequest): string {
  const email = (request.body as { readonly email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? normalisedEmail(email) : '';
}

/**
 * The caller's network address, an IPv6 one as its /64: a residential line or a cloud machine holds
 *   a whole /64 and picks a new source address for each request, which the throttler's own tracker
 *   masks and a custom one must mask too.
 */
export function addressOf(request: TrackedRequest): string {
  return normalizeIp(request.ip, DEFAULT_IPV6_SUBNET_PREFIX);
}

/**
 * Who a cap counts: the network address until a device carries a verified identity (core's
 *   `AuthRateLimit` says why), the typed email from one network for password guessing, so nobody
 *   spends another's allowance (`FailedSignIns` slows the rest), and the account for a resend.
 */
const TRACKERS: Record<AuthRateLimitName, (request: TrackedRequest) => string> = {
  SIGN_UP_PER_ADDRESS: addressOf,
  SIGN_IN_PER_ADDRESS: addressOf,
  SIGN_IN_PER_EMAIL: (request) => `${emailOf(request)} ${addressOf(request)}`,
  EMAIL_VERIFICATION_CONFIRM_PER_ADDRESS: addressOf,
  EMAIL_VERIFICATION_RESEND_PER_ACCOUNT: (request) =>
    viewerOf(request)?.accountId ?? addressOf(request),
  EMAIL_VERIFICATION_RESEND_PER_ACCOUNT_DAILY: (request) =>
    viewerOf(request)?.accountId ?? addressOf(request),
};

/**
 * One named throttler per cap, each skipped on every route that does not name it. Its limit is the
 *   caller's family's: core's high ceiling for an IPv4 address, which carriers share (CGNAT), the
 *   tight one for an IPv6 /64.
 */
export function authThrottlers(reflector: Reflector): ThrottlerOptions[] {
  return (Object.keys(AuthRateLimit) as AuthRateLimitName[]).map((name) => ({
    name,
    limit: (context: ExecutionContext) =>
      limitForAddress(
        AuthRateLimit[name],
        isIPv4(addressOf(context.switchToHttp().getRequest<TrackedRequest>())),
      ),
    ttl: seconds(AuthRateLimit[name].windowSeconds),
    skipIf: (context: ExecutionContext) =>
      !(
        reflector
          .getAllAndOverride(RateLimitedBy, [context.getHandler(), context.getClass()])
          ?.includes(name) ?? false
      ),
    getTracker: (request: Record<string, unknown>) =>
      TRACKERS[name](request as unknown as TrackedRequest),
  }));
}

/**
 * `@nestjs/throttler`'s guard, refusing in the contract's shape: `api.rate_limited` with
 *   `retryAfterMs` and its header (storefront.yaml `TooManyRequests`), never its English message.
 */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  protected override throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const retryAfterMs = Math.max(0, detail.timeToBlockExpire) * 1000;
    context
      .switchToHttp()
      .getResponse<{ header(name: string, value: string): unknown }>()
      .header('retry-after-ms', String(retryAfterMs));
    throw new RefusalException(HttpStatus.TOO_MANY_REQUESTS, {
      code: ApiErrorCode.RATE_LIMITED,
      params: { retryAfterMs },
      nature: FailureNature.UNAVAILABLE,
    });
  }
}
