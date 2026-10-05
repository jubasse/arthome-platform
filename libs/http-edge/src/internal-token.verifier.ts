import { isDevelopmentTokenKey, type JwksSource } from '@arthome-platform/config';
import { Logger } from '@nestjs/common';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
  type FetchImplementation,
  type JWTVerifyGetKey,
} from 'jose';

import {
  ApiErrorCode,
  audienceOf,
  INTERNAL_TOKEN_ALGORITHM,
  INTERNAL_TOKEN_ISSUERS,
  INTERNAL_TOKEN_LIFETIME_SECONDS,
  isKeyIdOfIssuer,
  TOKEN_CLOCK_TOLERANCE_SECONDS,
  type Clock,
} from '@arthome/core';
import { InternalTokenClaimsSchema } from '@arthome/core/schema';

import { unauthenticated, type Principal } from './principal.js';
import type { RefusalException } from './refusal.js';
import { refusalCausedBy, refusalOf } from './refusal.js';

function tokenExpired(): RefusalException {
  return refusalOf(ApiErrorCode.TOKEN_EXPIRED);
}

/** The keys could not be read: nothing is known about the token, and the fault is ours. */
function keysUnavailable(cause: unknown): RefusalException {
  return refusalCausedBy(cause, ApiErrorCode.SERVICE_UNAVAILABLE);
}

/** What a caller's token can be blamed for; anything else is the key set failing us. */
const TOKEN_FAULTS = [
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];

/**
 * The published development key is dropped from a fetched document, so a CDN document that carries
 * it by mistake, under any `kid`, still verifies nothing signed with it.
 */
const withoutDevelopmentKey: FetchImplementation = async (url, options) => {
  const response = await fetch(url, options);
  if (!response.ok) return response;
  const document = (await response.json()) as { readonly keys?: unknown };
  const keys = Array.isArray(document.keys)
    ? document.keys.filter(
        (key: { readonly x?: unknown; readonly y?: unknown }) => !isDevelopmentTokenKey(key),
      )
    : document.keys;
  return Response.json({ ...document, keys }, { status: response.status });
};

/**
 * Verifies the internal token locally (critical rule 4): the algorithm, the two BFFs as issuers,
 * this service as audience and the `kid` prefix bound to the issuer, all pinned, and the instant
 * read from the service's clock. The key set is built once: `createRemoteJWKSet` caches the
 * document and refetches on an unknown `kid`, which is what a rotation relies on (§8.1).
 */
export class InternalTokenVerifier {
  private readonly logger = new Logger(InternalTokenVerifier.name);
  private readonly keys: JWTVerifyGetKey;

  public constructor(
    private readonly service: string,
    source: JwksSource,
    private readonly clock: Clock,
  ) {
    this.keys =
      source.kind === 'remote'
        ? createRemoteJWKSet(new URL(source.url), { [customFetch]: withoutDevelopmentKey })
        : createLocalJWKSet({ keys: [...source.keys] });
  }

  public async verify(token: string): Promise<Principal> {
    let verified;
    try {
      verified = await jwtVerify(token, this.keys, {
        algorithms: [INTERNAL_TOKEN_ALGORITHM],
        issuer: [...INTERNAL_TOKEN_ISSUERS],
        audience: audienceOf(this.service),
        clockTolerance: TOKEN_CLOCK_TOLERANCE_SECONDS,
        maxTokenAge: INTERNAL_TOKEN_LIFETIME_SECONDS,
        requiredClaims: ['iat', 'exp'],
        currentDate: new Date(this.clock.nowMs()),
      });
    } catch (error) {
      throw this.refusalFor(error);
    }

    const claims = InternalTokenClaimsSchema.safeParse(verified.payload);
    if (!claims.success || !isKeyIdOfIssuer(verified.protectedHeader.kid, claims.data.iss)) {
      // Quoted: the kid is the caller's to choose, and a raw one could forge a log line.
      this.logger.warn(
        `an internal token signed with ${JSON.stringify(verified.protectedHeader.kid ?? null)} was refused`,
      );
      throw unauthenticated();
    }
    return {
      accountId: claims.data.sub ?? null,
      profileId: claims.data.pro ?? null,
      deviceId: claims.data.did ?? null,
      issuer: claims.data.iss,
    };
  }

  /** Either way nothing is let through: the split only says whose fault it is. */
  private refusalFor(error: unknown): RefusalException {
    if (error instanceof errors.JWTExpired) return tokenExpired();
    if (TOKEN_FAULTS.some((fault) => error instanceof fault)) return unauthenticated();
    this.logger.error('the JWKS document could not be read', error);
    return keysUnavailable(error);
  }
}
