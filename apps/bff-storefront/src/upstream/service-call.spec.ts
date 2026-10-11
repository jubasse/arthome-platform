import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineErrorModel, routeBuilder } from '@arthome/contracts/http';
import { FixedClock, Surface } from '@arthome/core';

import { budgetOf, serviceCallFor, withinBudget } from './service-call.js';
import type { ServiceCall } from './service-client.js';

const NOW = Date.parse('2026-10-05T10:00:00.000Z');
const clock = new FixedClock(NOW);
const builder = routeBuilder(
  defineErrorModel<string>({ standard: {}, envelopeOf: () => z.object({}) }),
)
  .version(1)
  .public();
const ok = { 200: { description: 'Ok.' } } as const;

function callDueIn(milliseconds: number): ServiceCall {
  return {
    deadline: new Date(NOW + milliseconds),
    traceparent: '',
    callerLeft: new AbortController().signal,
    caller: null,
  };
}

describe('budgetOf', () => {
  it('reads the latency budget the BFF route declares', () => {
    const search = builder
      .budget(200)
      .defineRoute({ method: 'get', path: '/search', operationId: 'search', responses: ok });

    expect(budgetOf(search)).toBe(200);
  });

  it('refuses a route that declares none, rather than inventing a deadline', () => {
    const search = builder.defineRoute({
      method: 'get',
      path: '/search',
      operationId: 'search',
      responses: ok,
    });

    expect(() => budgetOf(search)).toThrow('search calls a service and declares no budget.');
  });
});

describe('withinBudget', () => {
  it('gives up at the end of the called route’s budget when it comes before the caller’s deadline', () => {
    expect(withinBudget(callDueIn(2_000), 150, clock).deadline).toEqual(new Date(NOW + 150));
  });

  it('keeps the caller’s deadline when it comes first, or when the route declares no budget', () => {
    const call = callDueIn(100);

    expect(withinBudget(call, 150, clock)).toBe(call);
    expect(withinBudget(call, undefined, clock)).toBe(call);
  });
});

describe('serviceCallFor', () => {
  const response = (): ServerResponse => new ServerResponse(new IncomingMessage(new Socket()));

  it('carries the request’s surface as the actor’s, and none when the request named none', () => {
    const named = serviceCallFor(
      { headers: { 'x-arthome-surface': Surface.STOREFRONT_WEB } },
      response(),
      clock,
      200,
      null,
    );
    const unnamed = serviceCallFor({ headers: {} }, response(), clock, 200, null);

    expect(named.actorSurface).toBe(Surface.STOREFRONT_WEB);
    expect(unnamed).not.toHaveProperty('actorSurface');
  });
});
