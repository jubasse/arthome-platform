import type { ServerResponse } from 'node:http';

import { whenCallerLeaves } from '@arthome-platform/http-edge';

import type { Clock } from '@arthome/core';

import type { Caller } from '../internal-token.minter.js';
import type { ServiceCall } from './service-client.js';

/** transport.md §5.9's authentication write. */
export const AUTHENTICATION_WRITE_BUDGET_MS = 2_000;

/** transport.md §5.9's session validation. */
export const SESSION_VALIDATION_BUDGET_MS = 150;

/** What the BFF knows of the request a call to a service is made for. */
export interface InboundRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** A call to a service on behalf of `request`, given up `budgetMs` from now on the BFF's clock. */
export function serviceCallFor(
  request: InboundRequest,
  response: ServerResponse,
  clock: Clock,
  budgetMs: number,
  caller: Caller | null,
): ServiceCall {
  const traceparent = request.headers.traceparent;
  return {
    deadline: new Date(clock.nowMs() + budgetMs),
    // `TraceparentMiddleware` has written one on every request by now.
    traceparent: typeof traceparent === 'string' ? traceparent : '',
    callerLeft: whenCallerLeaves(response),
    caller,
  };
}
