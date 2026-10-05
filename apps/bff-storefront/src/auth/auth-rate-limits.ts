import { isIPv4 } from 'node:net';

import { refusalOf, routeOf, type RuleGuard } from '@arthome-platform/http-edge';
import { Injectable, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import {
  DEFAULT_IPV6_SUBNET_PREFIX,
  normalizeIp,
  seconds,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerOptions,
} from '@nestjs/throttler';

import type { Requirement, Route } from '@arthome/contracts/http';
import { ApiErrorCode, AuthRateLimit, limitForAddress } from '@arthome/core';

import { viewerOf } from '../session/viewer.js';

export type AuthRateLimitName = keyof typeof AuthRateLimit;

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
 * The caps each bucket a route can declare counts against, `throttle(bucket)` in core's contract.
 *   Core names a bucket after its cap where it has one; a bucket without a cap has no entry, and a
 *   bound route declaring it fails the boot rather than go uncounted.
 */
export const CAPS_OF_BUCKET: Readonly<Record<string, readonly AuthRateLimitName[]>> =
  Object.fromEntries(
    (Object.keys(AuthRateLimit) as AuthRateLimitName[]).map((name) => [name, [name]]),
  );

function bucketOf(rule: Requirement): string {
  return String((rule.params as { readonly bucket?: unknown }).bucket);
}

/** Every cap the route's throttle rules count against, in the order it declares them. */
export function capsOfRoute(route: Route | undefined): readonly AuthRateLimitName[] {
  return (route?.requires ?? [])
    .filter((rule) => rule.name === 'throttle')
    .flatMap((rule) => CAPS_OF_BUCKET[bucketOf(rule)] ?? []);
}

/**
 * One named throttler per cap, each skipped on every route whose contract does not declare a bucket
 *   that holds it. Its limit is the caller's family's: core's high ceiling for an IPv4 address, which
 *   carriers share (CGNAT), the tight one for an IPv6 /64.
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
    skipIf: (context: ExecutionContext) => !capsOfRoute(routeOf(reflector, context)).includes(name),
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
    throw refusalOf(ApiErrorCode.RATE_LIMITED, { retryAfterMs });
  }
}

/**
 * `throttle(bucket)`: counted by the global `AuthThrottlerGuard` from the route's contract, so this
 *   rule only makes the boot refuse a bucket that holds no cap.
 */
@Injectable()
export class ThrottleRule implements RuleGuard {
  public check(): Promise<void> {
    return Promise.resolve();
  }

  public problemWith(rule: Requirement): string | undefined {
    return CAPS_OF_BUCKET[bucketOf(rule)] === undefined
      ? `no cap named ${bucketOf(rule)}`
      : undefined;
  }
}
