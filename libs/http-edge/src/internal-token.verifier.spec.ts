import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { readInternalTokenSigningKey } from '@arthome-platform/config';
import { SignJWT, exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ApiErrorCode,
  FixedClock,
  INTERNAL_TOKEN_LIFETIME_SECONDS,
  InternalTokenIssuer,
  Service,
  TOKEN_CLOCK_TOLERANCE_SECONDS,
  audienceOf,
} from '@arthome/core';

import { InternalTokenVerifier } from './internal-token.verifier.js';
import { RefusalException } from './refusal.js';

const NOW_MS = Date.parse('2026-10-03T12:00:00.000Z');
const NOW_S = NOW_MS / 1000;
const ACCOUNT = '019a0000-0000-7000-8000-00000000a11c';
const DEVICE = '019a0000-0000-7000-8000-00000000d0d0';

interface Signer {
  readonly kid: string;
  readonly privateJwk: JWK;
  readonly publicJwk: JWK;
}

async function signerWith(kid: string): Promise<Signer> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  return {
    kid,
    privateJwk: await exportJWK(privateKey),
    publicJwk: { ...(await exportJWK(publicKey)), kid },
  };
}

interface Claims {
  readonly iss?: string;
  readonly aud?: string;
  readonly sub?: string;
  readonly did?: string;
  readonly iat?: number;
  readonly exp?: number;
}

async function tokenFrom(signer: Signer, claims: Claims = {}): Promise<string> {
  const iat = claims.iat ?? NOW_S;
  return new SignJWT({
    ...(claims.sub !== undefined && { sub: claims.sub }),
    ...(claims.did !== undefined && { did: claims.did }),
  })
    .setProtectedHeader({ alg: 'ES256', kid: signer.kid })
    .setIssuer(claims.iss ?? InternalTokenIssuer.STOREFRONT_BFF)
    .setAudience(claims.aud ?? audienceOf(Service.TICKETING))
    .setIssuedAt(iat)
    .setExpirationTime(claims.exp ?? iat + INTERNAL_TOKEN_LIFETIME_SECONDS)
    .sign(await importJWK(signer.privateJwk, 'ES256'));
}

function verifierOf(
  signers: readonly Signer[],
  service: string = Service.TICKETING,
): InternalTokenVerifier {
  return new InternalTokenVerifier(
    service,
    { kind: 'local', keys: signers.map((signer) => signer.publicJwk as Record<string, string>) },
    new FixedClock(NOW_MS),
  );
}

async function refusalOf(pending: Promise<unknown>): Promise<RefusalException> {
  const outcome = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(RefusalException);
  return outcome as RefusalException;
}

let storefront: Signer;
let studio: Signer;
let device: Signer;

beforeAll(async () => {
  storefront = await signerWith('bff-sf-2026-10-01');
  studio = await signerWith('bff-st-2026-10-01');
  device = await signerWith('dev-2026-10-01');
});

describe('a token the storefront BFF minted for this service', () => {
  it('names the account and the device it was minted for', async () => {
    const principal = await verifierOf([storefront]).verify(
      await tokenFrom(storefront, { sub: ACCOUNT, did: DEVICE }),
    );
    expect(principal).toEqual({
      accountId: ACCOUNT,
      profileId: null,
      deviceId: DEVICE,
      issuer: InternalTokenIssuer.STOREFRONT_BFF,
    });
  });

  it('names no account for an anonymous visitor', async () => {
    const principal = await verifierOf([storefront]).verify(await tokenFrom(storefront));
    expect(principal.accountId).toBeNull();
  });
});

describe('the audience is pinned', () => {
  it('refuses a token minted for another service', async () => {
    const forCatalog = await tokenFrom(storefront, { aud: audienceOf(Service.CATALOG) });
    const refusal = await refusalOf(verifierOf([storefront]).verify(forCatalog));
    expect(refusal.getStatus()).toBe(401);
    expect(refusal.refusal.code).toBe(ApiErrorCode.UNAUTHENTICATED);
    await expect(
      verifierOf([storefront], Service.CATALOG).verify(forCatalog),
    ).resolves.toBeDefined();
  });
});

describe('the issuer is pinned, and bound to its key', () => {
  it('refuses an issuer that is not one of the two BFFs', async () => {
    const refusal = await refusalOf(
      verifierOf([storefront]).verify(await tokenFrom(storefront, { iss: 'arthome.identity' })),
    );
    expect(refusal.refusal.code).toBe(ApiErrorCode.UNAUTHENTICATED);
  });

  it('refuses a token claiming one BFF and signed with the other one’s key', async () => {
    const forged = await tokenFrom(studio, { iss: InternalTokenIssuer.STOREFRONT_BFF });
    const refusal = await refusalOf(verifierOf([storefront, studio]).verify(forged));
    expect(refusal.refusal.code).toBe(ApiErrorCode.UNAUTHENTICATED);
  });

  it('refuses the device key signing as a BFF, though the JWKS document carries it', async () => {
    const forged = await tokenFrom(device, { sub: ACCOUNT });
    const refusal = await refusalOf(verifierOf([storefront, device]).verify(forged));
    expect(refusal.refusal.code).toBe(ApiErrorCode.UNAUTHENTICATED);
  });

  it('refuses a key it does not know', async () => {
    const stranger = await signerWith('bff-sf-unknown');
    const refusal = await refusalOf(verifierOf([storefront]).verify(await tokenFrom(stranger)));
    expect(refusal.refusal.code).toBe(ApiErrorCode.UNAUTHENTICATED);
  });
});

describe('the algorithm is pinned', () => {
  it('refuses an unsigned token', async () => {
    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'none', kid: storefront.kid })}.${encode({
      iss: InternalTokenIssuer.STOREFRONT_BFF,
      aud: audienceOf(Service.TICKETING),
      sub: ACCOUNT,
      iat: NOW_S,
      exp: NOW_S + 60,
    })}.`;
    const refusal = await refusalOf(verifierOf([storefront]).verify(unsigned));
    expect(refusal.refusal.code).toBe(ApiErrorCode.UNAUTHENTICATED);
  });

  it('refuses an HMAC token keyed with the public key', async () => {
    const publicKeyAsSecret = new TextEncoder().encode(JSON.stringify(storefront.publicJwk));
    const confused = await new SignJWT({ sub: ACCOUNT })
      .setProtectedHeader({ alg: 'HS256', kid: storefront.kid })
      .setIssuer(InternalTokenIssuer.STOREFRONT_BFF)
      .setAudience(audienceOf(Service.TICKETING))
      .setIssuedAt(NOW_S)
      .setExpirationTime(NOW_S + 60)
      .sign(publicKeyAsSecret);
    const refusal = await refusalOf(verifierOf([storefront]).verify(confused));
    expect(refusal.refusal.code).toBe(ApiErrorCode.UNAUTHENTICATED);
  });
});

describe('time is the service’s clock, with the declared tolerance', () => {
  it('accepts a token expired within the tolerance, and calls one past it expired', async () => {
    const lateButTolerated = await tokenFrom(storefront, {
      iat: NOW_S - INTERNAL_TOKEN_LIFETIME_SECONDS,
      exp: NOW_S - TOKEN_CLOCK_TOLERANCE_SECONDS + 1,
    });
    await expect(verifierOf([storefront]).verify(lateButTolerated)).resolves.toBeDefined();

    const expired = await tokenFrom(storefront, {
      iat: NOW_S - INTERNAL_TOKEN_LIFETIME_SECONDS - TOKEN_CLOCK_TOLERANCE_SECONDS - 1,
      exp: NOW_S - TOKEN_CLOCK_TOLERANCE_SECONDS - 1,
    });
    const refusal = await refusalOf(verifierOf([storefront]).verify(expired));
    expect(refusal.getStatus()).toBe(401);
    expect(refusal.refusal.code).toBe(ApiErrorCode.TOKEN_EXPIRED);
  });

  it('calls expired a token older than one call, whatever its exp claims', async () => {
    const longLived = await tokenFrom(storefront, {
      iat: NOW_S - 600,
      exp: NOW_S + 3_600,
    });
    const refusal = await refusalOf(verifierOf([storefront]).verify(longLived));
    expect(refusal.refusal.code).toBe(ApiErrorCode.TOKEN_EXPIRED);
  });

  it('refuses a token issued in the future beyond the tolerance', async () => {
    const early = await tokenFrom(storefront, { iat: NOW_S + TOKEN_CLOCK_TOLERANCE_SECONDS + 5 });
    const refusal = await refusalOf(verifierOf([storefront]).verify(early));
    expect(refusal.refusal.code).toBe(ApiErrorCode.UNAUTHENTICATED);
  });
});

describe('the JWKS document served over HTTP, through a rotation', () => {
  let server: Server;
  let published: JWK[] = [];
  let fetches = 0;
  let url: string;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      fetches += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: published }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('builds the key set once, and refetches it for a kid published later', async () => {
    const next = await signerWith('bff-sf-2026-10-31');
    published = [storefront.publicJwk];
    fetches = 0;
    const verifier = new InternalTokenVerifier(
      Service.TICKETING,
      { kind: 'remote', url },
      new FixedClock(NOW_MS),
    );

    await verifier.verify(await tokenFrom(storefront));
    await verifier.verify(await tokenFrom(storefront));
    expect(fetches).toBe(1);

    // Published before it signs (adr-auth.md §8.1). jose refetches on an unknown kid once its
    //   30 s cooldown has passed, on the machine's time, which is what moves here.
    published = [storefront.publicJwk, next.publicJwk];
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 31_000);
      await expect(verifier.verify(await tokenFrom(next))).resolves.toBeDefined();
      await expect(verifier.verify(await tokenFrom(storefront))).resolves.toBeDefined();
      expect(fetches).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a key the document no longer carries', async () => {
    const next = await signerWith('bff-sf-2026-10-31');
    published = [next.publicJwk];
    const verifier = new InternalTokenVerifier(
      Service.TICKETING,
      { kind: 'remote', url },
      new FixedClock(NOW_MS),
    );
    await expect(verifier.verify(await tokenFrom(next))).resolves.toBeDefined();
    const refusal = await refusalOf(verifier.verify(await tokenFrom(storefront)));
    expect(refusal.refusal.code).toBe(ApiErrorCode.UNAUTHENTICATED);
  });

  it('drops the published development key from the document, under any kid', async () => {
    const development = readInternalTokenSigningKey({ NODE_ENV: 'test' }).privateJwk;
    const { d: _private, ...publicHalf } = development;
    const renamed: Signer = {
      kid: 'bff-sf-2026-10-31',
      privateJwk: development,
      publicJwk: { ...publicHalf, kid: 'bff-sf-2026-10-31' },
    };
    published = [storefront.publicJwk, renamed.publicJwk];
    const verifier = new InternalTokenVerifier(
      Service.TICKETING,
      { kind: 'remote', url },
      new FixedClock(NOW_MS),
    );
    await expect(verifier.verify(await tokenFrom(storefront))).resolves.toBeDefined();
    const refusal = await refusalOf(verifier.verify(await tokenFrom(renamed)));
    expect(refusal.refusal.code).toBe(ApiErrorCode.UNAUTHENTICATED);
  });

  it('answers 503, not 401, when the document cannot be read', async () => {
    const unreachable = new InternalTokenVerifier(
      Service.TICKETING,
      { kind: 'remote', url: 'http://127.0.0.1:1/jwks.json' },
      new FixedClock(NOW_MS),
    );
    const refusal = await refusalOf(unreachable.verify(await tokenFrom(storefront)));
    expect(refusal.getStatus()).toBe(503);
    expect(refusal.refusal.code).toBe(ApiErrorCode.SERVICE_UNAVAILABLE);
  });
});
