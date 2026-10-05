import { unauthenticated, type IdentityGuard } from '@arthome-platform/http-edge';
import { Injectable, type ExecutionContext } from '@nestjs/common';

import type { Route } from '@arthome/contracts/http';

import { PairedDeviceVerifier } from './paired-device.verifier.js';
import { ViewerIdentity } from './viewer.identity.js';

/** `X-Arthome-Device-Token`, the paired device's credential, as Fastify lower-cases it. */
const DEVICE_TOKEN_HEADER = 'x-arthome-device-token';

/**
 * The `viewer_or_device` identity: the viewer's session first, then the paired device. A device
 *   token that names no paired device is refused, never let in as anonymous.
 */
@Injectable()
export class ViewerOrDeviceIdentity implements IdentityGuard {
  public constructor(
    private readonly viewer: ViewerIdentity,
    private readonly devices: PairedDeviceVerifier,
  ) {}

  public async identify(context: ExecutionContext, route: Route): Promise<unknown> {
    const viewer = await this.viewer.identify(context, route);
    if (viewer !== null) return viewer;
    const { headers } = context
      .switchToHttp()
      .getRequest<{ readonly headers: Readonly<Record<string, unknown>> }>();
    const token = headers[DEVICE_TOKEN_HEADER];
    if (token === undefined) return null;
    const device = typeof token === 'string' ? await this.devices.verify(token) : null;
    if (device === null) throw unauthenticated();
    return device;
  }
}
