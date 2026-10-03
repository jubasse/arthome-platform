import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import { ApiErrorCode, InternalTokenIssuer } from '@arthome/core';

import { AllowAnonymous } from './allow-anonymous.js';
import { InternalTokenGuard } from './internal-token.guard.js';
import type { InternalTokenVerifier } from './internal-token.verifier.js';
import { principalOf, type Principal } from './principal.js';
import { RefusalException } from './refusal.js';

const PRINCIPAL: Principal = {
  accountId: '019a0000-0000-7000-8000-00000000a11c',
  profileId: null,
  deviceId: null,
  issuer: InternalTokenIssuer.STOREFRONT_BFF,
};

class Routes {
  public purchase(): string {
    return 'purchase';
  }

  @AllowAnonymous()
  public webhook(): string {
    return 'webhook';
  }
}

function contextFor(
  handler: keyof Routes,
  headers: Record<string, string | undefined>,
  type = 'http',
): { readonly context: ExecutionContext; readonly request: object } {
  const request = { headers };
  const context = {
    getType: () => type,
    getHandler: () => (Routes.prototype as unknown as Record<string, () => string>)[handler],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

function guardWith(verify: (token: string) => Promise<Principal>): InternalTokenGuard {
  return new InternalTokenGuard({ verify } as unknown as InternalTokenVerifier, new Reflector());
}

async function refusalOf(pending: Promise<unknown>): Promise<RefusalException> {
  const outcome = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(RefusalException);
  return outcome as RefusalException;
}

describe('InternalTokenGuard', () => {
  it('verifies the bearer token and leaves its principal on the request', async () => {
    const verify = vi.fn(() => Promise.resolve(PRINCIPAL));
    const { context, request } = contextFor('purchase', { authorization: 'Bearer a.b.c' });

    await expect(guardWith(verify).canActivate(context)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('a.b.c');
    expect(principalOf(request)).toEqual(PRINCIPAL);
  });

  it('refuses a request without a token, or with another scheme, before verifying anything', async () => {
    const verify = vi.fn(() => Promise.resolve(PRINCIPAL));
    for (const authorization of [undefined, 'Basic a.b.c', 'Bearer ', 'Bearer a b']) {
      const refusal = await refusalOf(
        guardWith(verify).canActivate(contextFor('purchase', { authorization }).context),
      );
      expect(refusal.getStatus()).toBe(401);
      expect(refusal.refusal.code).toBe(ApiErrorCode.UNAUTHENTICATED);
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it('never accepts an identity header in the clear', async () => {
    const verify = vi.fn(() => Promise.resolve(PRINCIPAL));
    const { context, request } = contextFor('purchase', { 'x-user-id': PRINCIPAL.accountId ?? '' });

    await refusalOf(guardWith(verify).canActivate(context));
    expect(principalOf(request)).toBeNull();
  });

  it('lets an exempted route through with no token and no principal', async () => {
    const verify = vi.fn(() => Promise.resolve(PRINCIPAL));
    const { context, request } = contextFor('webhook', {});

    await expect(guardWith(verify).canActivate(context)).resolves.toBe(true);
    expect(principalOf(request)).toBeNull();
  });

  it('refuses a context it does not serve rather than waving it through', async () => {
    const verify = vi.fn(() => Promise.resolve(PRINCIPAL));
    await refusalOf(
      guardWith(verify).canActivate(
        contextFor('purchase', { authorization: 'Bearer a.b.c' }, 'rpc').context,
      ),
    );
  });
});
