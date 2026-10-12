import {
  AllowInProduction,
  Endpoint,
  EndpointInput,
  idempotencyKeyOf,
  markReplayed,
  unauthenticated,
} from '@arthome-platform/http-edge';
import { Controller, Header, Inject, Req, Res } from '@nestjs/common';

import type { HandlerInput, HandlerOutput, Route } from '@arthome/contracts/http';
import { SessionMode } from '@arthome/contracts/identity';
import { storefrontApi } from '@arthome/contracts/storefront-api';
import { PLAYBACK_TOKEN_LIFETIME_SECONDS, type Clock } from '@arthome/core';

import type { SessionReply } from '../auth/auth.controller.js';
import { CLOCK } from '../clock.js';
import { IdentityClient } from '../identity/identity.client.js';
import {
  clearDeviceCookie,
  clearSessionCookies,
  type CookieCarrier,
} from '../session/session-carriers.js';
import { callerOf, viewerOf, type Viewer } from '../session/viewer.js';
import { AUTHENTICATION_WRITE_BUDGET_MS, serviceCallFor } from '../upstream/service-call.js';
import type { ServiceCall } from '../upstream/service-client.js';
import { signedOutViewerContextOf, viewerContextOf } from '../viewer-context/viewer-context.js';

const { revokeDevice, signOutProfile } = storefrontApi.routes;

function sameId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * The viewer's devices and device sessions, ended at identity: who acts rides in the call's
 *   internal token alone, never in a body. Budget: transport.md §5.9 lists none for these account
 *   writes, so they take the authentication write's.
 */
@AllowInProduction()
@Controller()
export class DevicesController {
  public constructor(
    private readonly identity: IdentityClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Playback stops within the token in hand's lifetime, not the renewal interval: revocation
   *   refuses the next renewal. Revoking the browser's own device signs it out and forgets it.
   */
  @Endpoint(revokeDevice)
  @Header('cache-control', 'no-store')
  public async revokeDevice(
    @EndpointInput(revokeDevice) { params, headers }: HandlerInput<typeof revokeDevice>,
    @Req() request: CookieCarrier,
    @Res({ passthrough: true }) reply: SessionReply,
  ): Promise<HandlerOutput<typeof revokeDevice>> {
    const viewer = this.viewerOf(request);
    const { replayed } = await this.identity.revokeDevice(
      params.deviceId,
      idempotencyKeyOf(headers['idempotency-key']),
      this.callFor(viewer, request, reply, revokeDevice),
    );
    if (replayed) markReplayed(reply, this.clock);
    if (viewer.carrier === SessionMode.COOKIE && sameId(params.deviceId, viewer.deviceId)) {
      clearSessionCookies(reply);
      clearDeviceCookie(reply);
    }
    return { data: { playbackCutWithinSec: PLAYBACK_TOKEN_LIFETIME_SECONDS } };
  }

  /**
   * Signing out the viewer's own device session leaves the device signed out, its cookie kept as
   *   `signOut` keeps it; another session leaves the viewer's context as it was.
   */
  @Endpoint(signOutProfile)
  @Header('cache-control', 'no-store')
  public async signOutProfile(
    @EndpointInput(signOutProfile) { params, headers }: HandlerInput<typeof signOutProfile>,
    @Req() request: CookieCarrier,
    @Res({ passthrough: true }) reply: SessionReply,
  ): Promise<HandlerOutput<typeof signOutProfile>> {
    const viewer = this.viewerOf(request);
    const { replayed } = await this.identity.closeDeviceSession(
      params.sessionId,
      idempotencyKeyOf(headers['idempotency-key']),
      this.callFor(viewer, request, reply, signOutProfile),
    );
    if (replayed) markReplayed(reply, this.clock);
    const surface = headers['x-arthome-surface'];
    if (!sameId(params.sessionId, viewer.deviceSessionId)) {
      return { data: viewerContextOf(viewer, viewer.account, surface) };
    }
    if (viewer.carrier === SessionMode.COOKIE) clearSessionCookies(reply);
    return { data: signedOutViewerContextOf(viewer.deviceId, surface) };
  }

  private viewerOf(request: CookieCarrier): Viewer {
    const viewer = viewerOf(request);
    if (viewer === null) throw unauthenticated();
    return viewer;
  }

  private callFor(
    viewer: Viewer,
    request: CookieCarrier,
    reply: SessionReply,
    route: Route,
  ): ServiceCall {
    return serviceCallFor(
      request,
      reply.raw,
      this.clock,
      AUTHENTICATION_WRITE_BUDGET_MS,
      callerOf(viewer),
      route,
    );
  }
}
