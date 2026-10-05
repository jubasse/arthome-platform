import { unauthenticated, type IdentityGuard } from '@arthome-platform/http-edge';
import { Injectable, type ExecutionContext } from '@nestjs/common';

import type { Route } from '@arthome/contracts/http';

import { ViewerIdentity } from './viewer.identity.js';

/** `X-Arthome-Device-Token`, the paired device's credential, as Fastify lower-cases it. */
const DEVICE_TOKEN_HEADER = 'x-arthome-device-token';

/**
 * The `viewer_or_device` identity: the viewer's session first, then the paired device. No device
 *   token is verified yet (pairing is not built), so one presented without a session is refused,
 *   never let in as anonymous.
 */
@Injectable()
export class ViewerOrDeviceIdentity implements IdentityGuard {
  public constructor(private readonly viewer: ViewerIdentity) {}

  public async identify(context: ExecutionContext, route: Route): Promise<unknown> {
    const viewer = await this.viewer.identify(context, route);
    if (viewer !== null) return viewer;
    const { headers } = context
      .switchToHttp()
      .getRequest<{ readonly headers: Readonly<Record<string, unknown>> }>();
    if (headers[DEVICE_TOKEN_HEADER] !== undefined) throw unauthenticated();
    return null;
  }
}
