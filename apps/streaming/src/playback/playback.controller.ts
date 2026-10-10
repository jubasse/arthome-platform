import {
  Endpoint,
  EndpointInput,
  assertSameCaller,
  profileOfPrincipal,
  refusalOf,
  refuse,
  remainingBeforeDeadline,
  type Principal,
} from '@arthome-platform/http-edge';
import { Controller, Inject, Logger, Res } from '@nestjs/common';

import type { HandlerInput, HandlerOutput } from '@arthome/contracts/http';
import { streamingServiceApi } from '@arthome/contracts/streaming-service-api';
import {
  ApiErrorCode,
  ChatMode,
  DisplayState,
  InternalTokenIssuer,
  WatchDenialReason,
  WatchScope,
  type Clock,
} from '@arthome/core';

import {
  PlaybackDesk,
  type Issued,
  type OpeningRefusal,
  type RenewalRefusal,
  type ScreensRefusal,
  type Viewer,
} from './playback-desk.js';
import { setCookieHeadersOf } from './playback-format.js';
import { CLOCK } from '../clock.js';
import { PlaybackSigningUnavailable } from '../media/media-ports.js';
import type { RunIncidentFacts } from '../run/run-facts.js';

const { openPlayback, renewPlaybackTicket, releasePlayback } = streamingServiceApi.routes;

type ServicePrincipal = HandlerInput<typeof openPlayback>['principal'];

interface CookieReply {
  header(name: 'set-cookie', value: string[]): unknown;
}

/** A 403 without a user: playback is always an account's, as the run desk is an operator's. */
function accountOf(principal: ServicePrincipal): string {
  if (principal.userId === null) throw refusalOf(ApiErrorCode.FORBIDDEN);
  return principal.userId;
}

/** http-edge's caller, a claim the token lacks read as null. */
function callerOf(principal: ServicePrincipal): Principal {
  return {
    accountId: principal.userId,
    profileId: principal.profileId ?? null,
    deviceId: principal.deviceId ?? null,
    issuer: InternalTokenIssuer.STOREFRONT_BFF,
  };
}

/** The account, the token's profile (403 without one) and its device (403 without one). */
function viewerOf(principal: ServicePrincipal): Viewer {
  const accountId = accountOf(principal);
  const caller = callerOf(principal);
  const profileId = profileOfPrincipal(caller);
  if (caller.deviceId === null) throw refusalOf(ApiErrorCode.FORBIDDEN);
  return { accountId, profileId, deviceId: caller.deviceId };
}

function openingRefused(refusal: OpeningRefusal): unknown {
  switch (refusal.refusedWith) {
    case 'not_found':
      return refuse(openPlayback, ApiErrorCode.NOT_FOUND);
    case WatchDenialReason.CONCURRENT_LIMIT_REACHED:
      return refuse(openPlayback, refusal.refusedWith, screensOf(refusal));
    default:
      return refuse(openPlayback, refusal.refusedWith);
  }
}

function renewalRefused(refusal: RenewalRefusal): unknown {
  switch (refusal.refusedWith) {
    case 'not_found':
      return refuse(renewPlaybackTicket, ApiErrorCode.NOT_FOUND);
    case WatchDenialReason.CONCURRENT_LIMIT_REACHED:
      return refuse(renewPlaybackTicket, refusal.refusedWith, screensOf(refusal));
    default:
      return refuse(renewPlaybackTicket, refusal.refusedWith);
  }
}

function screensOf({ allowed, activeSessions }: ScreensRefusal) {
  return { allowed, activeSessions };
}

/** The storefront's `IncidentSchema` reads no null message: the veil without one omits it. */
function incidentOf(incident: RunIncidentFacts | null) {
  if (incident === null) return null;
  const { message, ...veil } = incident;
  return message === null ? veil : { ...veil, message };
}

/**
 * The player's three routes for the storefront BFF (C3), the only evaluation of the right that
 *   produces a token. `no-store`, the deadline and the caller come from the routes; no token or
 *   cookie value is ever logged.
 */
@Controller()
export class PlaybackController {
  private readonly logger = new Logger(PlaybackController.name);

  public constructor(
    private readonly desk: PlaybackDesk,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Endpoint(openPlayback)
  public async open(
    @EndpointInput(openPlayback)
    { params, body, headers, principal }: HandlerInput<typeof openPlayback>,
    @Res({ passthrough: true }) reply: CookieReply,
  ): Promise<HandlerOutput<typeof openPlayback>> {
    remainingBeforeDeadline(headers['x-arthome-deadline'], this.clock);
    if (body.kind === DisplayState.REPLAY) throw refuse(openPlayback, WatchDenialReason.NO_REPLAY);
    const viewer = viewerOf(principal);
    assertSameCaller(callerOf(principal), {
      deviceId: body.deviceId,
      ...(body.profileId != null && { profileId: body.profileId }),
    });

    const opened = await this.signed(params.dateId, () =>
      this.desk.open({
        viewer,
        dateId: params.dateId,
        surface: headers['x-arthome-surface'],
        viewerCountry: headers['x-arthome-viewer-country'],
        capabilities: body.capabilities,
      }),
    );
    if (opened.refusedWith !== undefined) throw openingRefused(opened);
    const { session, signed } = opened;
    setCookies(reply, opened);
    return {
      data: {
        sessionId: session.id,
        resumedExistingSession: opened.resumedExistingSession,
        dateId: session.dateId,
        scope: session.scope,
        previewSecondsLeft: session.scope === WatchScope.PREVIEW ? opened.previewSecondsLeft : null,
        protocol: session.protocol,
        drmSystem: session.drmSystem,
        qualityCap: session.qualityCap,
        manifestUrl: signed.manifestUrl,
        signature: { queryToken: signed.queryToken, cookieSet: signed.cookies.length > 0 },
        edgeRenewalMode: session.edgeRenewalMode,
        expiresAt: session.tokenExpiresAt,
        renewAfterSec: opened.renewAfterSec,
        leaseExpiresAt: session.leaseExpiresAt,
        resumePoint: null,
        chatMode: ChatMode.OFF,
        incident: incidentOf(opened.incident),
      },
    };
  }

  @Endpoint(renewPlaybackTicket)
  public async renew(
    @EndpointInput(renewPlaybackTicket)
    { params, headers, principal }: HandlerInput<typeof renewPlaybackTicket>,
    @Res({ passthrough: true }) reply: CookieReply,
  ): Promise<HandlerOutput<typeof renewPlaybackTicket>> {
    remainingBeforeDeadline(headers['x-arthome-deadline'], this.clock);
    const viewer = viewerOf(principal);
    const renewed = await this.signed(params.sessionId, () =>
      this.desk.renew(viewer, params.sessionId, headers['x-arthome-viewer-country'], (session) =>
        assertSameCaller(callerOf(principal), {
          profileId: session.profileId,
          deviceId: session.deviceId,
        }),
      ),
    );
    if (renewed.refusedWith !== undefined) throw renewalRefused(renewed);
    const { session, signed } = renewed;
    setCookies(reply, renewed);
    return {
      data: {
        expiresAt: session.tokenExpiresAt,
        renewAfterSec: renewed.renewAfterSec,
        leaseExpiresAt: session.leaseExpiresAt,
        signature: { queryToken: signed.queryToken, cookieSet: signed.cookies.length > 0 },
        qualityCap: session.qualityCap,
      },
    };
  }

  /** Speeds a screen's release up and guarantees nothing: the token in hand stays valid at the edge. */
  @Endpoint(releasePlayback)
  public async release(
    @EndpointInput(releasePlayback)
    { params, headers, principal }: HandlerInput<typeof releasePlayback>,
  ): Promise<HandlerOutput<typeof releasePlayback>> {
    remainingBeforeDeadline(headers['x-arthome-deadline'], this.clock);
    const released = await this.desk.release(accountOf(principal), params.sessionId);
    if (!released) throw refuse(releasePlayback, ApiErrorCode.NOT_FOUND);
  }

  /**
   * A provider that cannot sign the chosen way answers the service's 500 (C3 open point 4), logged
   *   with the mechanism and never the token; the lease it would have written is rolled back.
   */
  private async signed<T>(resourceId: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof PlaybackSigningUnavailable)) throw error;
      this.logger.error(`playback for ${resourceId} not signed: ${error.message}`);
      throw refusalOf(ApiErrorCode.INTERNAL);
    }
  }
}

function setCookies(reply: CookieReply, { signed }: Issued): void {
  if (signed.cookies.length > 0) reply.header('set-cookie', setCookieHeadersOf(signed.cookies));
}
