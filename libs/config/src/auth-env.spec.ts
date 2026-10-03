import { describe, expect, it } from 'vitest';

import {
  DEVELOPMENT_TOKEN_KEY_ID,
  DEVELOPMENT_TOKEN_PRIVATE_JWK,
} from './development-token-key.js';
import {
  readBetterAuthSecret,
  readCsrfSecret,
  readIdentityUrl,
  readInternalTokenSigningKey,
  readJwksSource,
  readTrustedProxies,
  readViewerCountryHeader,
} from './env.js';

const PRODUCTION_KEY = JSON.stringify({
  ...DEVELOPMENT_TOKEN_PRIVATE_JWK,
  kid: 'bff-sf-2026-10-03',
});

describe('the internal token signing key', () => {
  it('is the development key outside production, so a fresh clone signs', () => {
    expect(readInternalTokenSigningKey({ NODE_ENV: 'development' }).keyId).toBe(
      DEVELOPMENT_TOKEN_KEY_ID,
    );
  });

  it('is required in production, and the development key is refused there', () => {
    expect(() => readInternalTokenSigningKey({ NODE_ENV: 'production' })).toThrow(
      /INTERNAL_TOKEN_SIGNING_KEY/,
    );
    expect(() =>
      readInternalTokenSigningKey({
        NODE_ENV: 'production',
        INTERNAL_TOKEN_SIGNING_KEY: JSON.stringify(DEVELOPMENT_TOKEN_PRIVATE_JWK),
      }),
    ).toThrow(/development key/);
    expect(
      readInternalTokenSigningKey({
        NODE_ENV: 'production',
        INTERNAL_TOKEN_SIGNING_KEY: PRODUCTION_KEY,
      }).keyId,
    ).toBe('bff-sf-2026-10-03');
  });

  it('refuses a key that is not a private P-256 JWK', () => {
    const { d: _omitted, ...publicOnly } = DEVELOPMENT_TOKEN_PRIVATE_JWK;
    expect(() =>
      readInternalTokenSigningKey({
        NODE_ENV: 'test',
        INTERNAL_TOKEN_SIGNING_KEY: JSON.stringify(publicOnly),
      }),
    ).toThrow();
    expect(() =>
      readInternalTokenSigningKey({ NODE_ENV: 'test', INTERNAL_TOKEN_SIGNING_KEY: 'not json' }),
    ).toThrow(/not JSON/);
  });
});

describe('the JWKS a service verifies against', () => {
  it('is the development public half outside production, with no private part', () => {
    const jwks = readJwksSource({ NODE_ENV: 'test' });
    expect(jwks.kind).toBe('local');
    if (jwks.kind === 'local') {
      expect(jwks.keys).toHaveLength(1);
      expect(jwks.keys[0]).not.toHaveProperty('d');
      expect(jwks.keys[0]?.kid).toBe(DEVELOPMENT_TOKEN_KEY_ID);
    }
  });

  it('is the CDN document in production, over https only', () => {
    expect(() => readJwksSource({ NODE_ENV: 'production' })).toThrow(/JWKS_URL/);
    expect(() =>
      readJwksSource({ NODE_ENV: 'production', JWKS_URL: 'http://cdn.arthome.fr/jwks.json' }),
    ).toThrow(/JWKS_URL/);
    expect(
      readJwksSource({ NODE_ENV: 'production', JWKS_URL: 'https://cdn.arthome.fr/jwks.json' }),
    ).toEqual({ kind: 'remote', url: 'https://cdn.arthome.fr/jwks.json' });
  });
});

describe('the secrets and addresses of the authentication edge', () => {
  it('defaults outside production and requires them in production', () => {
    expect(readBetterAuthSecret({ NODE_ENV: 'test' }).length).toBeGreaterThanOrEqual(32);
    expect(readCsrfSecret({ NODE_ENV: 'test' }).length).toBeGreaterThanOrEqual(32);
    expect(readIdentityUrl({ NODE_ENV: 'test' })).toBe('http://localhost:3001');
    expect(() => readBetterAuthSecret({ NODE_ENV: 'production' })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => readCsrfSecret({ NODE_ENV: 'production', CSRF_SECRET: 'short' })).toThrow(
      /CSRF_SECRET/,
    );
    expect(() => readIdentityUrl({ NODE_ENV: 'production' })).toThrow(/IDENTITY_URL/);
  });

  it('trusts no proxy unless told, and refuses an entry that is not an address', () => {
    expect(readTrustedProxies({})).toEqual([]);
    expect(readTrustedProxies({ TRUSTED_PROXIES: '10.0.0.0/8, 127.0.0.1' })).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
    ]);
    expect(() => readTrustedProxies({ TRUSTED_PROXIES: 'everything' })).toThrow();
  });

  it('reads the country header only when one is named, and requires one in production', () => {
    expect(readViewerCountryHeader({ NODE_ENV: 'development' })).toBeNull();
    expect(
      readViewerCountryHeader({ NODE_ENV: 'production', VIEWER_COUNTRY_HEADER: 'CF-IPCountry' }),
    ).toBe('cf-ipcountry');
    expect(() => readViewerCountryHeader({ NODE_ENV: 'production' })).toThrow(
      /VIEWER_COUNTRY_HEADER/,
    );
    expect(() =>
      readViewerCountryHeader({ NODE_ENV: 'test', VIEWER_COUNTRY_HEADER: 'not a header' }),
    ).toThrow(/VIEWER_COUNTRY_HEADER/);
  });
});
