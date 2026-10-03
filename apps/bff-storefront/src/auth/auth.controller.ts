import type { ServerResponse } from 'node:http';

import { AllowInProduction, idempotencyKeyOf, unauthenticated } from '@arthome-platform/http-edge';
import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';

import { SessionMode } from '@arthome/contracts/identity';
import type { Clock, StorefrontSurface } from '@arthome/core';

import { RateLimitedBy } from './auth-rate-limits.js';
import {
  SignInRequestSchema,
  SignUpRequestSchema,
  VerificationLinkSchema,
  type SignInRequest,
  type SignUpRequest,
  type VerificationLink,
} from './auth-requests.schema.js';
import { viewerCountryOf } from './viewer-country.js';
import { CLOCK } from '../clock.js';
import type { SessionOpened } from '../identity/identity-answers.schema.js';
import { IdentityClient } from '../identity/identity.client.js';
import { OpensNoSession } from '../session/csrf.guard.js';
import {
  clearSessionCookies,
  presentedSession,
  setSessionCookies,
  type CookieCarrier,
  type CookieReply,
} from '../session/session-carriers.js';
import { CurrentViewer, RequiresViewer, callerOf, type Viewer } from '../session/viewer.js';
import { SURFACE_HEADER, assertStorefrontSurface } from '../storefront-surface.js';
import { AUTHENTICATION_WRITE_BUDGET_MS, serviceCallFor } from '../upstream/service-call.js';
import type { ServiceCall } from '../upstream/service-client.js';
import { viewerContextOf, type ServedViewerContext } from '../viewer-context/viewer-context.js';

export const VIEWER_COUNTRY_HEADER: unique symbol = Symbol('ViewerCountryHeader');

/** Fastify's reply with `@fastify/cookie` and `@fastify/csrf-protection` registered. */
export interface SessionReply extends CookieReply {
  readonly raw: ServerResponse;
  header(name: string, value: string): unknown;
  generateCsrf(options: { readonly userInfo: string }): string;
}

type Inbound = CookieCarrier;

/** storefront.yaml `SessionEstablished`: a cookie and nothing in the body, or a token and no cookie. */
export type SessionEstablished =
  | { readonly mode: typeof SessionMode.COOKIE; readonly viewerContext: ServedViewerContext }
  | {
      readonly mode: typeof SessionMode.BEARER | typeof SessionMode.DEVICE;
      readonly accessToken: string;
      readonly refreshToken: null;
      readonly expiresAt: string;
      readonly viewerContext: ServedViewerContext;
    };

/**
 * `/v1/auth/*`, the documented relay to identity (D-023, `adr-auth.md` §8.2): the contract's
 *   bodies and codes, the delivery mode chosen here and nowhere else, the caps, and the cookie's
 *   hardening. better-auth's own shapes and English never reach a surface.
 */
@AllowInProduction()
@Controller('v1/auth')
export class AuthController {
  public constructor(
    private readonly identity: IdentityClient,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(VIEWER_COUNTRY_HEADER) private readonly countryHeader: string | null,
  ) {}

  /** A replayed key answers the first session again, with `Idempotency-Replayed`. */
  @Post('sign-up')
  @HttpCode(201)
  @Header('cache-control', 'no-store')
  @OpensNoSession()
  @RateLimitedBy(['SIGN_UP_PER_ADDRESS'])
  public async signUp(
    @Body({ schema: SignUpRequestSchema }) body: SignUpRequest,
    @Req() request: Inbound,
    @Res({ passthrough: true }) reply: SessionReply,
    @Headers(SURFACE_HEADER) surface?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SessionEstablished> {
    const storefront = assertStorefrontSurface(surface);
    const { body: opened, replayed } = await this.identity.signUp(
      {
        email: body.email,
        password: body.password,
        ...(body.displayName !== undefined && { displayName: body.displayName }),
        locale: body.locale,
        country: viewerCountryOf(request.headers, this.countryHeader),
        acceptedTermsVersion: body.acceptedTermsVersion,
      },
      idempotencyKeyOf(idempotencyKey),
      this.anonymousCall(request, reply),
    );
    if (replayed) reply.header('idempotency-replayed', 'true');
    return this.established(body.mode, opened, storefront, reply);
  }

  /** No idempotency key, by the contract's prohibition: a replay would open a session unchecked. */
  @Post('sign-in')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @OpensNoSession()
  @RateLimitedBy(['SIGN_IN_PER_ADDRESS', 'SIGN_IN_PER_EMAIL'])
  public async signIn(
    @Body({ schema: SignInRequestSchema }) body: SignInRequest,
    @Req() request: Inbound,
    @Res({ passthrough: true }) reply: SessionReply,
    @Headers(SURFACE_HEADER) surface?: string,
  ): Promise<SessionEstablished> {
    const storefront = assertStorefrontSurface(surface);
    const opened = await this.identity.signIn(
      body.email,
      body.password,
      this.anonymousCall(request, reply),
    );
    return this.established(body.mode, opened, storefront, reply);
  }

  /**
   * Closes the presented session and nothing else, and succeeds again on a replay: a session already
   *   gone is still signed out. In cookie mode the cookies leave with the attributes that set them.
   */
  @Post('sign-out')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public async signOut(
    @Req() request: Inbound,
    @Res({ passthrough: true }) reply: SessionReply,
    @Headers(SURFACE_HEADER) surface?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<{ readonly signedOut: true }> {
    assertStorefrontSurface(surface);
    idempotencyKeyOf(idempotencyKey);
    const presented = presentedSession(request);
    if (presented === null) throw unauthenticated();
    await this.identity.revoke(presented.token, this.anonymousCall(request, reply));
    if (presented.carrier === SessionMode.COOKIE) clearSessionCookies(reply);
    return { signedOut: true };
  }

  @Post('verify-email')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @OpensNoSession()
  @RateLimitedBy(['EMAIL_VERIFICATION_CONFIRM_PER_ADDRESS'])
  public async confirmEmailVerification(
    @Body({ schema: VerificationLinkSchema }) body: VerificationLink,
    @Req() request: Inbound,
    @Res({ passthrough: true }) reply: SessionReply,
    @Headers(SURFACE_HEADER) surface?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<{ readonly verified: boolean }> {
    assertStorefrontSurface(surface);
    const { body: verified, replayed } = await this.identity.confirmVerification(
      body.token,
      idempotencyKeyOf(idempotencyKey),
      this.anonymousCall(request, reply),
    );
    if (replayed) reply.header('idempotency-replayed', 'true');
    return verified;
  }

  @Post('verify-email/resend')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  @RequiresViewer()
  @RateLimitedBy(['EMAIL_VERIFICATION_RESEND_PER_ACCOUNT'])
  public async resendEmailVerification(
    @CurrentViewer() viewer: Viewer,
    @Req() request: Inbound,
    @Res({ passthrough: true }) reply: SessionReply,
    @Headers(SURFACE_HEADER) surface?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<{ readonly sent: boolean }> {
    assertStorefrontSurface(surface);
    const { body: sent, replayed } = await this.identity.resendVerification(
      idempotencyKeyOf(idempotencyKey),
      serviceCallFor(
        request,
        reply.raw,
        this.clock,
        AUTHENTICATION_WRITE_BUDGET_MS,
        callerOf(viewer),
      ),
    );
    if (replayed) reply.header('idempotency-replayed', 'true');
    return sent;
  }

  private anonymousCall(request: Inbound, reply: SessionReply): ServiceCall {
    return serviceCallFor(request, reply.raw, this.clock, AUTHENTICATION_WRITE_BUDGET_MS, null);
  }

  /** The mode is the surface's explicit choice (D-023), never inferred from its `User-Agent`. */
  private established(
    mode: SignUpRequest['mode'],
    opened: SessionOpened,
    surface: StorefrontSurface,
    reply: SessionReply,
  ): SessionEstablished {
    const viewerContext = viewerContextOf(opened.session, opened.account, surface);
    if (mode === SessionMode.COOKIE) {
      const csrfToken = reply.generateCsrf({ userInfo: opened.session.token });
      setSessionCookies(reply, opened.session, csrfToken, this.clock.nowMs());
      return { mode, viewerContext };
    }
    return {
      mode,
      accessToken: opened.session.token,
      refreshToken: null,
      expiresAt: opened.session.expiresAt,
      viewerContext,
    };
  }
}
