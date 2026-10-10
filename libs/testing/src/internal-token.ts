import { readInternalTokenSigningKey } from '@arthome-platform/config';
import { SignJWT, importJWK, type JWK } from 'jose';

import {
  INTERNAL_TOKEN_ALGORITHM,
  INTERNAL_TOKEN_LIFETIME_SECONDS,
  InternalTokenIssuer,
  audienceOf,
  type Clock,
} from '@arthome/core';

/** The caller a suite sends its requests as: a BFF calling `service` for one account, or for none. */
export interface InternalCaller {
  readonly service: string;
  /** The suite's clock, the one the service verifies the token against. */
  readonly clock: Clock;
  readonly accountId?: string;
  readonly deviceId?: string;
  /** Minted as `pro`: a service route that reads the profile refuses a token without it. */
  readonly profileId?: string;
}

export interface MintOptions {
  readonly issuer?: string;
  readonly keyId?: string;
  readonly privateJwk?: JWK;
  readonly lifetimeSeconds?: number;
  readonly algorithm?: string;
}

/**
 * An internal token as the storefront BFF mints it, signed with the development key the services
 *   verify against outside production. A security suite overrides the key, issuer or lifetime.
 */
export async function mintInternalToken(
  caller: InternalCaller,
  options: MintOptions = {},
): Promise<string> {
  const development = readInternalTokenSigningKey({ NODE_ENV: 'test' });
  const algorithm = options.algorithm ?? INTERNAL_TOKEN_ALGORITHM;
  const key = await importJWK(options.privateJwk ?? { ...development.privateJwk }, algorithm);
  const issuedAt = Math.floor(caller.clock.nowMs() / 1000);
  return new SignJWT({
    ...(caller.accountId !== undefined && { sub: caller.accountId }),
    ...(caller.deviceId !== undefined && { did: caller.deviceId }),
    ...(caller.profileId !== undefined && { pro: caller.profileId }),
  })
    .setProtectedHeader({ alg: algorithm, kid: options.keyId ?? development.keyId })
    .setIssuer(options.issuer ?? InternalTokenIssuer.STOREFRONT_BFF)
    .setAudience(audienceOf(caller.service))
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + (options.lifetimeSeconds ?? INTERNAL_TOKEN_LIFETIME_SECONDS))
    .sign(key);
}
