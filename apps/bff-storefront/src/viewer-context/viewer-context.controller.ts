import {
  AllowInProduction,
  Endpoint,
  EndpointInput,
  unauthenticated,
} from '@arthome-platform/http-edge';
import { Controller, Inject, Req, Res } from '@nestjs/common';

import type { HandlerInput, HandlerOutput } from '@arthome/contracts/http';
import { SessionMode } from '@arthome/contracts/identity';
import { storefrontApi } from '@arthome/contracts/storefront-api';
import type { Clock } from '@arthome/core';

import { viewerContextOf } from './viewer-context.js';
import type { SessionReply } from '../auth/auth.controller.js';
import { CLOCK } from '../clock.js';
import { setSessionCookies, type CookieCarrier } from '../session/session-carriers.js';
import { viewerOf } from '../session/viewer.js';

const { getViewerContext } = storefrontApi.routes;

/**
 * `getViewerContext`, the start-up screen's one call, answered from the session `ViewerIdentity`
 *   resolved: identity returns the account with it. In cookie mode it also carries the session's
 *   current expiry back to the browser: identity slides the session at most once a day, and a cookie
 *   that kept its first `Max-Age` would leave a live session behind on the seventh day.
 */
@AllowInProduction()
@Controller()
export class ViewerContextController {
  public constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  @Endpoint(getViewerContext)
  public viewerContext(
    @EndpointInput(getViewerContext) { headers }: HandlerInput<typeof getViewerContext>,
    @Req() request: CookieCarrier,
    @Res({ passthrough: true }) reply: SessionReply,
  ): Promise<HandlerOutput<typeof getViewerContext>> {
    const viewer = viewerOf(request);
    if (viewer === null) throw unauthenticated();
    if (viewer.carrier === SessionMode.COOKIE) {
      setSessionCookies(reply, request, viewer, this.clock.nowMs());
    }
    return Promise.resolve({
      data: viewerContextOf(viewer, viewer.account, headers['x-arthome-surface']),
    });
  }
}
