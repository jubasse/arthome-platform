import { RefusalException } from '@arthome-platform/http-edge';
import { HttpStatus, Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector, type ReflectableDecorator } from '@nestjs/core';
import {
  ThrottlerGuard,
  seconds,
  type ThrottlerLimitDetail,
  type ThrottlerOptions,
} from '@nestjs/throttler';

import { ApiErrorCode, AuthRateLimit, FailureNature } from '@arthome/core';

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

function emailOf(request: TrackedRequest): string {
  const email = (request.body as { readonly email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * Who a cap counts: the network address until a device carries a verified identity (core's
 *   `AuthRateLimit` says why), the typed address for password guessing, the account for a resend.
 */
const TRACKERS: Record<AuthRateLimitName, (request: TrackedRequest) => string> = {
  SIGN_UP_PER_ADDRESS: (request) => request.ip,
  SIGN_IN_PER_ADDRESS: (request) => request.ip,
  SIGN_IN_PER_EMAIL: emailOf,
  EMAIL_VERIFICATION_CONFIRM_PER_ADDRESS: (request) => request.ip,
  EMAIL_VERIFICATION_RESEND_PER_ACCOUNT: (request) => viewerOf(request)?.accountId ?? request.ip,
};

/** One named throttler per cap, each skipped on every route that does not name it. */
export function authThrottlers(reflector: Reflector): ThrottlerOptions[] {
  return (Object.keys(AuthRateLimit) as AuthRateLimitName[]).map((name) => ({
    name,
    limit: AuthRateLimit[name].limit,
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
