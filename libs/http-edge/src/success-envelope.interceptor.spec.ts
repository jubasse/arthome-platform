import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { FixedClock } from '@arthome/core';

import { SuccessEnvelopeInterceptor } from './success-envelope.interceptor.js';

const SERVED_AT = '2026-09-25T10:11:12.000Z';

function contextOfType(type: string): ExecutionContext {
  return { getType: () => type } as unknown as ExecutionContext;
}

function handlerReturning(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

describe('the success envelope', () => {
  it('wraps the handler’s value and stamps servedAt from the clock', async () => {
    const interceptor = new SuccessEnvelopeInterceptor(new FixedClock(SERVED_AT));

    const sent = await lastValueFrom(
      interceptor.intercept(contextOfType('http'), handlerReturning({ publicHandle: 'ada' })),
    );

    expect(sent).toEqual({ servedAt: SERVED_AT, data: { publicHandle: 'ada' } });
  });

  /** ⚠ A global interceptor reaches WS and RPC, and neither carries this envelope. */
  it.each(['ws', 'rpc', 'graphql'])('leaves a %s payload untouched', async (type) => {
    const interceptor = new SuccessEnvelopeInterceptor(new FixedClock(SERVED_AT));

    const sent = await lastValueFrom(
      interceptor.intercept(contextOfType(type), handlerReturning({ raw: true })),
    );

    expect(sent).toEqual({ raw: true });
  });

  it('wraps a null body rather than dropping the envelope', async () => {
    const interceptor = new SuccessEnvelopeInterceptor(new FixedClock(SERVED_AT));

    const sent = await lastValueFrom(
      interceptor.intercept(contextOfType('http'), handlerReturning(null)),
    );

    expect(sent).toEqual({ servedAt: SERVED_AT, data: null });
  });

  /** ⚠ §5.5 makes `validUntil` conditional, so its absence is the contract, not an omission. */
  it('does not invent validUntil', async () => {
    const interceptor = new SuccessEnvelopeInterceptor(new FixedClock(SERVED_AT));

    const sent = await lastValueFrom(
      interceptor.intercept(contextOfType('http'), handlerReturning({ showId: 'x' })),
    );

    expect(Object.keys(sent as object).sort()).toEqual(['data', 'servedAt']);
  });
});
