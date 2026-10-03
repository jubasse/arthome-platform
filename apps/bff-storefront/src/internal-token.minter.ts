import type { SigningKey } from '@arthome-platform/config';
import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, importJWK, type CryptoKey } from 'jose';

import {
  INTERNAL_TOKEN_ALGORITHM,
  INTERNAL_TOKEN_LIFETIME_SECONDS,
  InternalTokenIssuer,
  audienceOf,
  isKeyIdOfIssuer,
  type Clock,
} from '@arthome/core';

import { CLOCK } from './clock.js';

export const SIGNING_KEY: unique symbol = Symbol('SigningKey');

/** Who a call to a service is made for. Null: an anonymous visitor. */
export interface Caller {
  readonly accountId: string;
  readonly deviceId: string;
}

/**
 * Mints the token each call to a service carries (`adr-auth.md` §8): ES256, this BFF as issuer, the
 *   service as audience, the account and its device, sixty seconds from the injected clock. One
 *   per call, never reused for another service.
 */
@Injectable()
export class InternalTokenMinter {
  private key: Promise<CryptoKey> | null = null;

  public constructor(
    @Inject(SIGNING_KEY) private readonly signingKey: SigningKey,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    if (!isKeyIdOfIssuer(signingKey.keyId, InternalTokenIssuer.STOREFRONT_BFF)) {
      throw new Error(`the storefront BFF signs with a bff-sf- key, not ${signingKey.keyId}`);
    }
  }

  public async mint(service: string, caller: Caller | null): Promise<string> {
    const issuedAt = Math.floor(this.clock.nowMs() / 1000);
    return new SignJWT(caller === null ? {} : { sub: caller.accountId, did: caller.deviceId })
      .setProtectedHeader({ alg: INTERNAL_TOKEN_ALGORITHM, kid: this.signingKey.keyId })
      .setIssuer(InternalTokenIssuer.STOREFRONT_BFF)
      .setAudience(audienceOf(service))
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + INTERNAL_TOKEN_LIFETIME_SECONDS)
      .sign(await this.privateKey());
  }

  private privateKey(): Promise<CryptoKey> {
    this.key ??= importJWK(
      { ...this.signingKey.privateJwk },
      INTERNAL_TOKEN_ALGORITHM,
    ) as Promise<CryptoKey>;
    return this.key;
  }
}
