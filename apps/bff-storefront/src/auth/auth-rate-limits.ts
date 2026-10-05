import { isIPv4 } from 'node:net';

import { refusalOf, type RuleGuard } from '@arthome-platform/http-edge';
import { Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector, type ReflectableDecorator } from '@nestjs/core';
import {
  DEFAULT_IPV6_SUBNET_PREFIX,
  normalizeIp,
  seconds,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerOptions,
} from '@nestjs/throttler';

import type { Requirement } from '@arthome/contracts/http';
import { ApiErrorCode, AuthRateLimit, limitForAddress } from '@arthome/core';

import { viewerOf } from '../session/viewer.js';

export type AuthRateLimitName = keyof typeof AuthRateLimit;

/**
 * The caps a route counts against, by their name in core's `AuthRateLimit`.
 * @deprecated A route declares `requires(throttle(cap))`, which `ThrottleRule` counts.
 */
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
  /** One cap counted for a route that declares it as a rule, past the `skipIf` legacy routes go through. */
  public async countAgainst(context: ExecutionContext, name: AuthRateLimitName): Promise<void> {
    const throttler = this.throttlers.find((candidate) => candidate.name === name);
    const { getTracker, generateKey } = this.commonOptions;
    if (throttler === undefined || getTracker === undefined || generateKey === undefined) {
      throw new Error(`No cap named ${name} is bound.`);
    }
    const ttl = typeof throttler.ttl === 'function' ? await throttler.ttl(context) : throttler.ttl;
    await this.handleRequest({
      context,
      limit:
        typeof throttler.limit === 'function' ? await throttler.limit(context) : throttler.limit,
      ttl,
      blockDuration: ttl,
      throttler,
      getTracker: throttler.getTracker ?? getTracker,
      generateKey: throttler.generateKey ?? generateKey,
    });
  }

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

function isCapName(bucket: unknown): bucket is AuthRateLimitName {
  return typeof bucket === 'string' && Object.hasOwn(AuthRateLimit, bucket);
}

/**
 * The bucket the auth routes declare until core names one cap per bucket. Each of those routes still
 *   names its caps with `@RateLimitedBy`, which `AuthThrottlerGuard` counts on every request, so
 *   counting them here as well would halve them.
 */
const AUTH_BUCKET = 'auth';

/** `throttle(bucket)`, a bucket being one of core's `AuthRateLimit` caps: `SIGN_IN_PER_EMAIL`. */
@Injectable()
export class ThrottleRule implements RuleGuard {
  public constructor(
    private readonly throttler: AuthThrottlerGuard,
    private readonly reflector: Reflector,
  ) {}

  public check(context: ExecutionContext, rule: Requirement): Promise<void> {
    const { bucket } = rule.params as { readonly bucket?: unknown };
    if (bucket === AUTH_BUCKET) {
      const caps = this.reflector.getAllAndOverride(RateLimitedBy, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (caps === undefined || caps.length === 0) {
        throw new Error(`A route throttled by the ${AUTH_BUCKET} bucket names no cap.`);
      }
      return Promise.resolve();
    }
    if (!isCapName(bucket)) throw new Error(`No cap named ${String(bucket)}.`);
    return this.throttler.countAgainst(context, bucket);
  }

  public problemWith(rule: Requirement): string | undefined {
    const { bucket } = rule.params as { readonly bucket?: unknown };
    return bucket === AUTH_BUCKET || isCapName(bucket)
      ? undefined
      : `no cap named ${String(bucket)}`;
  }
}
