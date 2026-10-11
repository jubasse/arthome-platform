import { createHash, timingSafeEqual } from 'node:crypto';

import { unauthenticated, type IdentityGuard } from '@arthome-platform/http-edge';
import { Inject, Injectable, type ExecutionContext } from '@nestjs/common';
import type { z } from 'zod';

import type { MediaServerPrincipalSchema } from '@arthome/contracts/http';

/** `readMediaServerSecret()`: a token, so a suite binds its own. */
export const MEDIA_SERVER_SECRET: unique symbol = Symbol('MediaServerSecret');

const BASIC = /^Basic ([A-Za-z0-9+/]+={0,2})$/;

interface HeaderCarrier {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

function digestOf(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

/**
 * Core's `mediaServer` identity: MediaMTX's HTTP Basic credential, taken from the userinfo of its
 *   `authHTTPAddress`. The password is the shared secret, the username is ignored. Compared as two
 *   SHA-256 digests in constant time, so neither the length nor a prefix of the secret leaks.
 */
@Injectable()
export class MediaServerIdentity implements IdentityGuard {
  private readonly secretDigest: Buffer;

  public constructor(@Inject(MEDIA_SERVER_SECRET) secret: string) {
    this.secretDigest = digestOf(secret);
  }

  public identify(
    context: ExecutionContext,
  ): Promise<z.output<typeof MediaServerPrincipalSchema> | null> {
    const header = context.switchToHttp().getRequest<HeaderCarrier>().headers.authorization;
    if (header === undefined) return Promise.resolve(null);
    const presented = typeof header === 'string' ? passwordOf(header) : null;
    if (presented === null || !timingSafeEqual(digestOf(presented), this.secretDigest)) {
      throw unauthenticated();
    }
    return Promise.resolve({});
  }
}

/** The password of a Basic credential; null when the header is not one. */
function passwordOf(header: string): string | null {
  const encoded = BASIC.exec(header)?.[1];
  if (encoded === undefined) return null;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon === -1 ? null : decoded.slice(colon + 1);
}
