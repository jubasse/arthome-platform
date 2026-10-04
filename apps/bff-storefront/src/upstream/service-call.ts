import type { ServerResponse } from 'node:http';

import { whenCallerLeaves } from '@arthome-platform/http-edge';

import type { Route } from '@arthome/contracts/http';
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

/** The latency budget a BFF route declares (transport.md §5.9): the deadline of the calls it makes. */
export function budgetOf(route: Route): number {
  if (route.budgetMs === undefined) {
    throw new Error(`${route.operationId} calls a service and declares no budget.`);
  }
  return route.budgetMs;
}

/**
 * A call to a route that declares its own budget: given up at the end of that budget, or at the
 *   caller's deadline if it comes first. The deadline is the call's, so the service gives up at the
 *   same instant (transport.md §5.3).
 */
export function withinBudget(
  call: ServiceCall,
  budgetMs: number | undefined,
  clock: Clock,
): ServiceCall {
  if (budgetMs === undefined) return call;
  const budgetEnds = clock.nowMs() + budgetMs;
  return budgetEnds < call.deadline.getTime() ? { ...call, deadline: new Date(budgetEnds) } : call;
}
