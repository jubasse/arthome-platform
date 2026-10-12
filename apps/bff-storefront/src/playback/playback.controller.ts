import type { ServerResponse } from 'node:http';

import {
  AllowInProduction,
  Endpoint,
  EndpointInput,
  unauthenticated,
} from '@arthome-platform/http-edge';
import { Controller, Header, Inject, Req, Res } from '@nestjs/common';

import type { HandlerInput, HandlerOutput, Route } from '@arthome/contracts/http';
import { storefrontApi } from '@arthome/contracts/storefront-api';
import type { Clock } from '@arthome/core';

import {
  appendSetCookies,
  relayedPlaybackCookies,
  type SetCookieReply,
} from './playback-cookies.js';
import { StreamingClient } from './streaming.client.js';
import { VIEWER_COUNTRY_HEADER } from '../auth/auth.controller.js';
import { viewerCountryOf } from '../auth/viewer-country.js';
import { CLOCK } from '../clock.js';
import type { CookieCarrier } from '../session/session-carriers.js';
import { callerOf, viewerOf } from '../session/viewer.js';
import { serviceCallFor } from '../upstream/service-call.js';
import type { ServiceCall } from '../upstream/service-client.js';

/** transport.md §5.9 lists `streaming.openPlayback` alone; renewal and release take its budget. */
export const OPEN_PLAYBACK_BUDGET_MS = 1_000;

export const PLAYBACK_COOKIE_DOMAIN: unique symbol = Symbol('PlaybackCookieDomain');

const { openPlayback, renewPlaybackTicket, releasePlayback } = storefrontApi.routes;

interface PlaybackReply extends SetCookieReply {
  readonly raw: ServerResponse;
}

/**
 * The player's three routes, relayed to streaming for the viewer the session names (its account,
 *   device and profile ride in the internal token). The browser's ticket comes back as a cookie
 *   (`adr-stream-entitlement.md` §3.2), relayed with a `Domain` that reaches the media edge.
 */
@AllowInProduction()
@Controller()
export class PlaybackController {
  public constructor(
    private readonly streaming: StreamingClient,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(VIEWER_COUNTRY_HEADER) private readonly countryHeader: string | null,
    @Inject(PLAYBACK_COOKIE_DOMAIN) private readonly cookieDomain: string | null,
  ) {}

  /** The body goes as the browser sent it: streaming refuses a device or profile not the token's. */
  @Endpoint(openPlayback)
  @Header('cache-control', 'no-store')
  public async open(
    @EndpointInput(openPlayback) { params, body, headers }: HandlerInput<typeof openPlayback>,
    @Req() request: CookieCarrier,
    @Res({ passthrough: true }) reply: PlaybackReply,
  ): Promise<HandlerOutput<typeof openPlayback>> {
    const { data, setCookies } = await this.streaming.open(
      params.dateId,
      body,
      headers['x-arthome-surface'],
      viewerCountryOf(request.headers, this.countryHeader),
      this.callFor(request, reply, openPlayback),
    );
    appendSetCookies(reply, relayedPlaybackCookies(setCookies, this.cookieDomain));
    return { data };
  }

  @Endpoint(renewPlaybackTicket)
  @Header('cache-control', 'no-store')
  public async renew(
    @EndpointInput(renewPlaybackTicket) { params }: HandlerInput<typeof renewPlaybackTicket>,
    @Req() request: CookieCarrier,
    @Res({ passthrough: true }) reply: PlaybackReply,
  ): Promise<HandlerOutput<typeof renewPlaybackTicket>> {
    const { data, setCookies } = await this.streaming.renew(
      params.sessionId,
      viewerCountryOf(request.headers, this.countryHeader),
      this.callFor(request, reply, renewPlaybackTicket),
    );
    appendSetCookies(reply, relayedPlaybackCookies(setCookies, this.cookieDomain));
    return { data };
  }

  @Endpoint(releasePlayback)
  @Header('cache-control', 'no-store')
  public async release(
    @EndpointInput(releasePlayback) { params }: HandlerInput<typeof releasePlayback>,
    @Req() request: CookieCarrier,
    @Res({ passthrough: true }) reply: PlaybackReply,
  ): Promise<HandlerOutput<typeof releasePlayback>> {
    await this.streaming.release(params.sessionId, this.callFor(request, reply, releasePlayback));
  }

  private callFor(request: CookieCarrier, reply: PlaybackReply, route: Route): ServiceCall {
    const viewer = viewerOf(request);
    if (viewer === null) throw unauthenticated();
    return serviceCallFor(
      request,
      reply.raw,
      this.clock,
      OPEN_PLAYBACK_BUDGET_MS,
      callerOf(viewer),
      route,
    );
  }
}
