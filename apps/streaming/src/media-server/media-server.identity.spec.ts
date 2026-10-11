import { RefusalException } from '@arthome-platform/http-edge';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ApiErrorCode } from '@arthome/core';

import { MediaServerIdentity } from './media-server.identity.js';

const SECRET = 'the-media-server-suites-shared-secret';
const identity = new MediaServerIdentity(SECRET);

function contextWith(authorization?: string): ExecutionContext {
  const request = { headers: authorization === undefined ? {} : { authorization } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function basic(credential: string): string {
  return `Basic ${Buffer.from(credential).toString('base64')}`;
}

async function refusalOf(authorization: string): Promise<unknown> {
  try {
    await identity.identify(contextWith(authorization));
  } catch (error) {
    return error;
  }
  throw new Error('accepted');
}

describe('MediaServerIdentity', () => {
  it('finds no credential when no authorization header is sent', async () => {
    expect(await identity.identify(contextWith())).toBeNull();
  });

  it.each([
    ['a bearer token', `Bearer ${SECRET}`],
    ['a Basic header that is not base64', 'Basic not base64!'],
    ['a Basic credential without a colon', basic(SECRET)],
    ['a wrong password', basic('mediamtx:not-the-secret-at-all-but-as-long')],
    ['the right password with a byte more', basic(`mediamtx:${SECRET}x`)],
    ['the right password cut short', basic(`mediamtx:${SECRET.slice(0, -1)}`)],
    ['the secret as the username', basic(`${SECRET}:`)],
  ])('refuses %s as unauthenticated', async (_case, authorization) => {
    const refusal = await refusalOf(authorization);

    expect(refusal).toBeInstanceOf(RefusalException);
    expect((refusal as RefusalException).getStatus()).toBe(401);
    expect((refusal as RefusalException).refusal.code).toBe(ApiErrorCode.UNAUTHENTICATED);
  });

  it('accepts the secret as the password, whatever the username', async () => {
    expect(await identity.identify(contextWith(basic(`mediamtx:${SECRET}`)))).toEqual({});
    expect(await identity.identify(contextWith(basic(`:${SECRET}`)))).toEqual({});
  });
});
