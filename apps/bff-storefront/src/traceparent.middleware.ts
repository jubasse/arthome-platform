import type { IncomingMessage } from 'node:http';

import { newTraceparent, parseTraceparent } from '@arthome-platform/http-edge';
import { Injectable, type NestMiddleware } from '@nestjs/common';

/**
 * The contract's `traceparent`: created by the surface when it can, otherwise here. Written on
 *   the request itself because the error filter reads it there, and the storefront contract
 *   requires a `traceId` on every error, so the call to the service and the error share a trace.
 */
@Injectable()
export class TraceparentMiddleware implements NestMiddleware {
  public use(request: IncomingMessage, _response: unknown, next: () => void): void {
    const inbound = request.headers.traceparent;
    if (parseTraceparent(typeof inbound === 'string' ? inbound : undefined) === null) {
      // eslint-disable-next-line no-param-reassign -- the mutation is the point: see above.
      request.headers.traceparent = newTraceparent();
    }
    next();
  }
}
