import { AllowInProduction } from '@arthome-platform/http-edge';
import { Controller, Get, Header, Headers, Inject, Req, Res } from '@nestjs/common';

import { SessionMode } from '@arthome/contracts/identity';
import type { Clock } from '@arthome/core';

import { viewerContextOf, type ServedViewerContext } from './viewer-context.js';
import type { SessionReply } from '../auth/auth.controller.js';
import { CLOCK } from '../clock.js';
import { IdentityClient } from '../identity/identity.client.js';
import { setSessionCookies, type CookieCarrier } from '../session/session-carriers.js';
import { CurrentViewer, RequiresViewer, callerOf, type Viewer } from '../session/viewer.js';
import { SURFACE_HEADER, VARY_AUTH, assertStorefrontSurface } from '../storefront-surface.js';
import { SESSION_VALIDATION_BUDGET_MS, serviceCallFor } from '../upstream/service-call.js';

/**
 * `getViewerContext`, the start-up screen's one call. In cookie mode it also carries the session's
 *   current expiry back to the browser: identity slides the session at most once a day, and a cookie
 *   that kept its first `Max-Age` would leave a live session behind on the seventh day.
 */
@AllowInProduction()
@Controller('v1')
export class ViewerContextController {
  public constructor(
    private readonly identity: IdentityClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** storefront.yaml: `x-arthome-freshness: 300`, and a body that is this viewer's alone. */
  @Get('viewer-context')
  @Header('cache-control', 'private, max-age=300')
  @Header('vary', VARY_AUTH)
  @RequiresViewer()
  public async viewerContext(
    @CurrentViewer() viewer: Viewer,
    @Req() request: CookieCarrier,
    @Res({ passthrough: true }) reply: SessionReply,
    @Headers(SURFACE_HEADER) surface?: string,
  ): Promise<ServedViewerContext> {
    const storefront = assertStorefrontSurface(surface);
    const account = await this.identity.viewer(
      serviceCallFor(
        request,
        reply.raw,
        this.clock,
        SESSION_VALIDATION_BUDGET_MS,
        callerOf(viewer),
      ),
    );
    if (viewer.carrier === SessionMode.COOKIE) {
      setSessionCookies(reply, request, viewer, this.clock.nowMs());
    }
    return viewerContextOf(viewer, account, storefront);
  }
}
