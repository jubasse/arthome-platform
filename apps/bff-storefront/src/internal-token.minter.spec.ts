import { readInternalTokenSigningKey } from '@arthome-platform/config';
import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';

import { FixedClock, Service } from '@arthome/core';

import { InternalTokenMinter } from './internal-token.minter.js';

const ACCOUNT = '01a0e700-0000-7000-8000-0000000000c1';
const DEVICE = '01a0e700-0000-7000-8000-0000000000e1';
const PROFILE = '01a0e700-0000-7000-8000-0000000000d1';

const minter = new InternalTokenMinter(
  readInternalTokenSigningKey({ NODE_ENV: 'test' }),
  new FixedClock(Date.parse('2026-10-06T10:00:00.000Z')),
);

describe('the internal token minter', () => {
  it('mints the profile as pro when the caller names one', async () => {
    const claims = decodeJwt(
      await minter.mint(Service.STREAMING, {
        accountId: ACCOUNT,
        deviceId: DEVICE,
        profileId: PROFILE,
      }),
    );

    expect(claims).toMatchObject({ sub: ACCOUNT, did: DEVICE, pro: PROFILE });
  });

  it('mints no pro when the caller names no profile, and no claim for an anonymous visitor', async () => {
    const signedIn = decodeJwt(
      await minter.mint(Service.STREAMING, { accountId: ACCOUNT, deviceId: DEVICE }),
    );
    const anonymous = decodeJwt(await minter.mint(Service.CATALOG, null));

    expect(signedIn).toMatchObject({ sub: ACCOUNT, did: DEVICE });
    expect(signedIn).not.toHaveProperty('pro');
    expect(anonymous).not.toHaveProperty('sub');
    expect(anonymous).not.toHaveProperty('did');
    expect(anonymous).not.toHaveProperty('pro');
  });
});
