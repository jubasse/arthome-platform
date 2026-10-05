import { AllowInProduction, Endpoint, EndpointHeaders } from '@arthome-platform/http-edge';
import { Controller, Header, Inject, Req, Res } from '@nestjs/common';

import type { HandlerOutput, RouteHeaders } from '@arthome/contracts/http';
import { SessionMode } from '@arthome/contracts/identity';
import { storefrontApi } from '@arthome/contracts/storefront-api';
import type { Clock } from '@arthome/core';

import { viewerContextOf } from './viewer-context.js';
import type { SessionReply } from '../auth/auth.controller.js';
import { CLOCK } from '../clock.js';
import { setSessionCookies, type CookieCarrier } from '../session/session-carriers.js';
import { CurrentViewer, RequiresViewer, type Viewer } from '../session/viewer.js';
import { VARY_AUTH } from '../storefront-surface.js';

const { getViewerContext } = storefrontApi.routes;

/**
 * `getViewerContext`, the start-up screen's one call, answered from the session `ViewerGuard`
 *   resolved: identity returns the account with it. In cookie mode it also carries the session's
 *   current expiry back to the browser: identity slides the session at most once a day, and a cookie
 *   that kept its first `Max-Age` would leave a live session behind on the seventh day.
 */
@AllowInProduction()
@Controller()
export class ViewerContextController {
  public constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /** storefront.yaml: `x-arthome-freshness: 300`, and a body that is this viewer's alone. */
  @Endpoint(getViewerContext)
  @Header('cache-control', 'private, max-age=300')
  @Header('vary', VARY_AUTH)
  @RequiresViewer()
  public viewerContext(
    @CurrentViewer() viewer: Viewer,
    @EndpointHeaders(getViewerContext) headers: RouteHeaders<typeof getViewerContext>,
    @Req() request: CookieCarrier,
    @Res({ passthrough: true }) reply: SessionReply,
  ): Promise<HandlerOutput<typeof getViewerContext>> {
    if (viewer.carrier === SessionMode.COOKIE) {
      setSessionCookies(reply, request, viewer, this.clock.nowMs());
    }
    return Promise.resolve({
      data: viewerContextOf(viewer, viewer.account, headers['x-arthome-surface']),
    });
  }
}
