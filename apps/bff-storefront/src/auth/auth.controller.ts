import type { ServerResponse } from 'node:http';

import {
  AllowInProduction,
  Endpoint,
  EndpointInput,
  RefusalException,
  idempotencyKeyOf,
  unauthenticated,
} from '@arthome-platform/http-edge';
import { Controller, Header, Inject, Logger, Req, Res } from '@nestjs/common';

import type { HandlerInput, HandlerOutput, Route, RouteBody } from '@arthome/contracts/http';
import { SessionMode } from '@arthome/contracts/identity';
import { storefrontApi } from '@arthome/contracts/storefront-api';
import { IdentityErrorCode, type Clock, type StorefrontSurface } from '@arthome/core';

import { FailedSignIns } from './failed-sign-ins.js';
import { viewerCountryOf } from './viewer-country.js';
import { CLOCK } from '../clock.js';
import type { SessionOpened } from '../identity/identity-answers.schema.js';
import { IdentityClient } from '../identity/identity.client.js';
import {
  clearSessionCookies,
  presentedSession,
  setSessionCookies,
  type CookieCarrier,
  type CsrfReply,
  type PresentedSession,
} from '../session/session-carriers.js';
import { callerOf, viewerOf } from '../session/viewer.js';
import { AUTHENTICATION_WRITE_BUDGET_MS, serviceCallFor } from '../upstream/service-call.js';
import type { ServiceCall } from '../upstream/service-client.js';
import { viewerContextOf, type ServedViewerContext } from '../viewer-context/viewer-context.js';

const { signUp, signIn, signOut, confirmEmailVerification, resendEmailVerification } =
  storefrontApi.routes;

export const VIEWER_COUNTRY_HEADER: unique symbol = Symbol('ViewerCountryHeader');

/** Fastify's reply with `@fastify/cookie` and `@fastify/csrf-protection` registered. */
export interface SessionReply extends CsrfReply {
  readonly raw: ServerResponse;
  header(name: string, value: string): unknown;
}

type Inbound = CookieCarrier;

/** Any session the request carries, a malformed carrier being none: it is about to be replaced. */
function replacedSession(request: Inbound): PresentedSession | null {
  try {
    return presentedSession(request);
  } catch {
    return null;
  }
}

function isWrongPassword(error: unknown): boolean {
  return (
    error instanceof RefusalException &&
    error.refusal.code === IdentityErrorCode.INVALID_CREDENTIALS
  );
}

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
@Controller()
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  public constructor(
    private readonly identity: IdentityClient,
    private readonly failedSignIns: FailedSignIns,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(VIEWER_COUNTRY_HEADER) private readonly countryHeader: string | null,
  ) {}

  /** A replayed key answers the first session again, with `Idempotency-Replayed`. */
  @Endpoint(signUp)
  @Header('cache-control', 'no-store')
  public async signUp(
    @EndpointInput(signUp) { body, headers }: HandlerInput<typeof signUp>,
    @Req() request: Inbound,
    @Res({ passthrough: true }) reply: SessionReply,
  ): Promise<HandlerOutput<typeof signUp>> {
    const { body: opened, replayed } = await this.identity.signUp(
      {
        email: body.email,
        password: body.password,
        ...(body.displayName !== undefined && { displayName: body.displayName }),
        locale: body.locale,
        country: viewerCountryOf(request.headers, this.countryHeader),
        acceptedTermsVersion: body.acceptedTermsVersion,
      },
      idempotencyKeyOf(headers['idempotency-key']),
      this.anonymousCall(request, reply, signUp),
    );
    if (replayed) reply.header('idempotency-replayed', 'true');
    await this.closeReplaced(request, reply, opened);
    return {
      data: this.established(body.mode, opened, headers['x-arthome-surface'], request, reply),
    };
  }

  /**
   * No idempotency key, by the contract's prohibition: a replay would open a session unchecked. The
   *   email's recent failures hold the attempt before identity hears it, and only a wrong password
   *   counts as one.
   */
  @Endpoint(signIn)
  @Header('cache-control', 'no-store')
  public async signIn(
    @EndpointInput(signIn) { body, headers }: HandlerInput<typeof signIn>,
    @Req() request: Inbound,
    @Res({ passthrough: true }) reply: SessionReply,
  ): Promise<HandlerOutput<typeof signIn>> {
    await this.failedSignIns.holdBefore(body.email);
    let opened: SessionOpened;
    try {
      opened = await this.identity.signIn(
        body.email,
        body.password,
        this.anonymousCall(request, reply, signIn),
      );
    } catch (error) {
      if (isWrongPassword(error)) await this.failedSignIns.count(body.email);
      throw error;
    }
    await this.failedSignIns.forget(body.email);
    await this.closeReplaced(request, reply, opened);
    return {
      data: this.established(body.mode, opened, headers['x-arthome-surface'], request, reply),
    };
  }

  /**
   * Closes the presented session and nothing else, and succeeds again on a replay: a session already
   *   gone is still signed out. In cookie mode the cookies leave with the attributes that set them.
   */
  @Endpoint(signOut)
  @Header('cache-control', 'no-store')
  public async signOut(
    @EndpointInput(signOut) { headers, principal }: HandlerInput<typeof signOut>,
    @Req() request: Inbound,
    @Res({ passthrough: true }) reply: SessionReply,
  ): Promise<HandlerOutput<typeof signOut>> {
    idempotencyKeyOf(headers['idempotency-key']);
    const presented = replacedSession(request);
    if (principal !== null && presented !== null) {
      await this.identity.revoke(presented.token, this.anonymousCall(request, reply, signOut));
    }
    if (presented?.carrier === SessionMode.COOKIE) clearSessionCookies(reply);
    return { data: { signedOut: true } };
  }

  @Endpoint(confirmEmailVerification)
  @Header('cache-control', 'no-store')
  public async confirmEmailVerification(
    @EndpointInput(confirmEmailVerification)
    { body, headers }: HandlerInput<typeof confirmEmailVerification>,
    @Req() request: Inbound,
    @Res({ passthrough: true }) reply: SessionReply,
  ): Promise<HandlerOutput<typeof confirmEmailVerification>> {
    const { body: verified, replayed } = await this.identity.confirmVerification(
      body.token,
      idempotencyKeyOf(headers['idempotency-key']),
      this.anonymousCall(request, reply, confirmEmailVerification),
    );
    if (replayed) reply.header('idempotency-replayed', 'true');
    return { data: verified };
  }

  @Endpoint(resendEmailVerification)
  @Header('cache-control', 'no-store')
  public async resendEmailVerification(
    @EndpointInput(resendEmailVerification)
    { headers }: HandlerInput<typeof resendEmailVerification>,
    @Req() request: Inbound,
    @Res({ passthrough: true }) reply: SessionReply,
  ): Promise<HandlerOutput<typeof resendEmailVerification>> {
    const viewer = viewerOf(request);
    if (viewer === null) throw unauthenticated();
    const { body: queued, replayed } = await this.identity.resendVerification(
      idempotencyKeyOf(headers['idempotency-key']),
      serviceCallFor(
        request,
        reply.raw,
        this.clock,
        AUTHENTICATION_WRITE_BUDGET_MS,
        callerOf(viewer),
        resendEmailVerification,
      ),
    );
    if (replayed) reply.header('idempotency-replayed', 'true');
    return { data: queued };
  }

  /**
   * Signing in over a session closes it, or it would live on for seven days in a browser that no
   *   longer holds it. Best effort: the new session is open, and a failure here must not lose it.
   */
  private async closeReplaced(
    request: Inbound,
    reply: SessionReply,
    opened: SessionOpened,
  ): Promise<void> {
    const replaced = replacedSession(request);
    if (replaced === null || replaced.token === opened.session.token) return;
    try {
      await this.identity.revoke(replaced.token, this.anonymousCall(request, reply));
    } catch (error) {
      this.logger.warn('the session signed in over could not be closed', error);
    }
  }

  private anonymousCall(request: Inbound, reply: SessionReply, route?: Route): ServiceCall {
    return serviceCallFor(
      request,
      reply.raw,
      this.clock,
      AUTHENTICATION_WRITE_BUDGET_MS,
      null,
      route,
    );
  }

  /** The mode is the surface's explicit choice (D-023), never inferred from its `User-Agent`. */
  private established(
    mode: RouteBody<typeof signUp>['mode'],
    opened: SessionOpened,
    surface: StorefrontSurface,
    request: Inbound,
    reply: SessionReply,
  ): SessionEstablished {
    const viewerContext = viewerContextOf(opened.session, opened.account, surface);
    if (mode === SessionMode.COOKIE) {
      setSessionCookies(reply, request, opened.session, this.clock.nowMs());
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
