import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { FixedClock } from '@arthome/core';

import {
  CollectionResponse,
  MemorisedResponse,
  SuccessEnvelopeInterceptor,
} from './success-envelope.interceptor.js';

const SERVED_AT = '2026-09-25T10:11:12.000Z';

function contextOfType(type: string): ExecutionContext {
  return { getType: () => type } as unknown as ExecutionContext;
}

function httpContextRecordingHeaders(): {
  readonly context: ExecutionContext;
  readonly headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  const reply = {
    header: (name: string, value: string) => {
      headers[name] = value;
    },
  };
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => reply }),
  } as unknown as ExecutionContext;
  return { context, headers };
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

  it('puts a collection’s fields at the root, with the instant its first perishable value expires', async () => {
    const interceptor = new SuccessEnvelopeInterceptor(new FixedClock(SERVED_AT));
    const page = { hasMore: false };

    const perishable = await lastValueFrom(
      interceptor.intercept(
        contextOfType('http'),
        handlerReturning(new CollectionResponse({ groups: [], page }, '2026-09-25T10:30:00.000Z')),
      ),
    );
    const lasting = await lastValueFrom(
      interceptor.intercept(
        contextOfType('http'),
        handlerReturning(new CollectionResponse({ items: [], page }, null)),
      ),
    );

    expect(perishable).toEqual({
      servedAt: SERVED_AT,
      validUntil: '2026-09-25T10:30:00.000Z',
      groups: [],
      page,
    });
    expect(lasting).toEqual({ servedAt: SERVED_AT, items: [], page });
  });

  /** A global interceptor reaches WS and RPC, and neither carries this envelope. */
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

  /** §5.5 makes `validUntil` conditional, so its absence is the contract, not an omission. */
  it('does not invent validUntil', async () => {
    const interceptor = new SuccessEnvelopeInterceptor(new FixedClock(SERVED_AT));

    const sent = await lastValueFrom(
      interceptor.intercept(contextOfType('http'), handlerReturning({ showId: 'x' })),
    );

    expect(Object.keys(sent as object).sort()).toEqual(['data', 'servedAt']);
  });

  it('sends a memorised envelope as stored, without wrapping it again', async () => {
    const interceptor = new SuccessEnvelopeInterceptor(new FixedClock(SERVED_AT));
    const stored = { servedAt: '2026-09-25T09:00:00.000Z', data: { dateId: 'd-1' } };
    const { context, headers } = httpContextRecordingHeaders();

    const sent = await lastValueFrom(
      interceptor.intercept(context, handlerReturning(new MemorisedResponse(stored, false))),
    );

    expect(sent).toBe(stored);
    expect(headers).toEqual({});
  });

  it('marks a replay, keeping the first servedAt in the body and stamping the replay in a header', async () => {
    const interceptor = new SuccessEnvelopeInterceptor(new FixedClock(SERVED_AT));
    const stored = { servedAt: '2026-09-25T09:00:00.000Z', data: { dateId: 'd-1' } };
    const { context, headers } = httpContextRecordingHeaders();

    const sent = await lastValueFrom(
      interceptor.intercept(context, handlerReturning(new MemorisedResponse(stored, true))),
    );

    expect(sent).toEqual(stored);
    expect(headers).toEqual({ 'Idempotency-Replayed': 'true', 'x-arthome-served-at': SERVED_AT });
  });
});
