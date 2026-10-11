import type { SigningKey } from '@arthome-platform/config';
import { SignJWT, importJWK, type CryptoKey } from 'jose';

import { audienceOf, toEpochMs } from '@arthome/core';

import type { PlaybackGrant } from './media-ports.js';

export const PLAYBACK_ALGORITHM = 'ES256';
/** The playback set's audience (`adr-auth.md` §8.1): an edge, never a service, reads it. */
export const PLAYBACK_AUDIENCE = audienceOf('cdn');
const URL_SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Each segment of a signed prefix: anything else could climb out of it once decoded. */
export function assertUrlSafeSegment(segment: string): void {
  if (!URL_SAFE_SEGMENT.test(segment)) throw new Error('a playback path segment must be URL-safe');
}

/** PS3's claims plus the path prefix the edge binds the token to (`adr-stream-entitlement.md` §3.2). */
export class PlaybackTokenSigner {
  private privateKey: Promise<CryptoKey> | null = null;

  public constructor(private readonly signingKey: SigningKey) {}

  public get keyId(): string {
    return this.signingKey.keyId;
  }

  public async sign(grant: PlaybackGrant, prefix: string): Promise<string> {
    return new SignJWT({ ...grant.claims, prefix })
      .setProtectedHeader({ alg: PLAYBACK_ALGORITHM, kid: this.signingKey.keyId })
      .setAudience(PLAYBACK_AUDIENCE)
      .setExpirationTime(Math.floor(toEpochMs(grant.expiresAt) / 1_000))
      .sign(await this.key());
  }

  private key(): Promise<CryptoKey> {
    this.privateKey ??= importJWK(
      { ...this.signingKey.privateJwk },
      PLAYBACK_ALGORITHM,
    ) as Promise<CryptoKey>;
    return this.privateKey;
  }
}
