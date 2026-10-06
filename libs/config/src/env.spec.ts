import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DEVELOPMENT_PLAYBACK_KEY_ID,
  DEVELOPMENT_PLAYBACK_PRIVATE_JWK,
} from './development-playback-key.js';
import { DEVELOPMENT_TOKEN_PRIVATE_JWK } from './development-token-key.js';
import {
  isProductionEnvironment,
  readKafkaBrokers,
  readBffEnv,
  readOpenSearchUrl,
  readPublicWebOrigin,
  readPaymentWebhookSecret,
  readPlaybackSigningKey,
  readRedisUrl,
  readStreamKeySecret,
  readConsumerEnv,
  readHttpServiceEnv,
  readSearchIndexerEnv,
} from './env.js';

const PRODUCTION = {
  NODE_ENV: 'production',
  PORT: '3000',
  DATABASE_URL: 'postgres://arthome:secret@db.internal:5432/identity',
  KAFKA_BROKERS: 'broker-a.internal:9092,broker-b.internal:9092',
  OPENSEARCH_URL: 'https://search.internal:9200',
};

describe('the local defaults stop at the production boundary', () => {
  it('fills them outside production', () => {
    expect(readHttpServiceEnv('identity', { NODE_ENV: 'development', PORT: '3000' })).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      DATABASE_URL: 'postgres://arthome:arthome@localhost:55432/identity',
    });
  });

  it('refuses a production deployment with no DATABASE_URL instead of using localhost', () => {
    expect(() =>
      readHttpServiceEnv('identity', { NODE_ENV: 'production', PORT: '3000' }),
    ).toThrow();
  });

  it('treats an empty variable as absent, so a valueless compose entry still defaults', () => {
    expect(
      readHttpServiceEnv('identity', { NODE_ENV: 'test', PORT: '3000', DATABASE_URL: '' })
        .DATABASE_URL,
    ).toBe('postgres://arthome:arthome@localhost:55432/identity');
  });

  it('never defaults NODE_ENV, because an unset one would open the guarded routes', () => {
    expect(() => readHttpServiceEnv('identity', { PORT: '3000' })).toThrow(/NODE_ENV/);
    expect(() => isProductionEnvironment({})).toThrow();
  });
});

describe('a broker list is a list, and it is not a URL', () => {
  it('splits every broker out, so KafkaJS is not handed one host containing a comma', () => {
    expect(readConsumerEnv('notifications', PRODUCTION).KAFKA_BROKERS).toEqual([
      'broker-a.internal:9092',
      'broker-b.internal:9092',
    ]);
  });

  it('refuses a broker with no port', () => {
    expect(() =>
      readConsumerEnv('notifications', { ...PRODUCTION, KAFKA_BROKERS: 'broker-a.internal' }),
    ).toThrow();
  });
});

describe('a URL variable asserts its protocol', () => {
  /**
   * `z.url()` ALONE PASSES THIS. The URL constructor reads `localhost:29092` as the
   * scheme `localhost:` with the path `29092`, so without the protocol assertion a
   * broker list pasted into DATABASE_URL validates and fails at connection time.
   */
  it('refuses a broker list pasted into DATABASE_URL', () => {
    expect(() =>
      readConsumerEnv('notifications', { ...PRODUCTION, DATABASE_URL: 'localhost:29092' }),
    ).toThrow();
  });

  it('refuses an http database and a postgres search index', () => {
    expect(() =>
      readConsumerEnv('notifications', { ...PRODUCTION, DATABASE_URL: 'http://localhost:55432/x' }),
    ).toThrow();
    expect(() =>
      readSearchIndexerEnv('search', {
        ...PRODUCTION,
        OPENSEARCH_URL: 'postgres://localhost:9200',
      }),
    ).toThrow();
  });
});

describe('PORT', () => {
  it('coerces the string the platform hands over', () => {
    expect(readHttpServiceEnv('identity', { NODE_ENV: 'test', PORT: '8080' }).PORT).toBe(8080);
  });

  /**
   * The migration CLI loads `data-source.ts` and never listens, so a required PORT
   * made `migration:run` unrunnable. A wrong port fails loudly, unlike a wrong
   * DATABASE_URL, which is why this one variable is defaulted and the rest are not.
   */
  it('defaults when the process does not listen', () => {
    expect(readHttpServiceEnv('identity', { NODE_ENV: 'test' }).PORT).toBe(3000);
  });

  it('refuses PORT=0, which `.int()` alone accepts', () => {
    expect(() => readHttpServiceEnv('identity', { NODE_ENV: 'test', PORT: '0' })).toThrow();
  });

  it('refuses a port outside the range', () => {
    expect(() => readHttpServiceEnv('identity', { NODE_ENV: 'test', PORT: '70000' })).toThrow();
  });
});

describe('isProductionEnvironment', () => {
  it('is an allow-list, so an environment nobody listed is production-like', () => {
    expect(isProductionEnvironment({ NODE_ENV: 'development' })).toBe(false);
    expect(isProductionEnvironment({ NODE_ENV: 'test' })).toBe(false);
    expect(isProductionEnvironment({ NODE_ENV: 'production' })).toBe(true);
    expect(() => isProductionEnvironment({ NODE_ENV: 'staging' })).toThrow();
  });
});

describe('readKafkaBrokers', () => {
  it('defaults outside production', () => {
    expect(readKafkaBrokers({ NODE_ENV: 'development' })).toEqual(['localhost:29092']);
  });

  it('refuses a production deployment with no broker list instead of using localhost', () => {
    expect(() => readKafkaBrokers({ NODE_ENV: 'production' })).toThrow(/KAFKA_BROKERS/);
  });

  it('splits the list, like every other reader', () => {
    expect(
      readKafkaBrokers({
        NODE_ENV: 'production',
        KAFKA_BROKERS: 'a.internal:9092,b.internal:9092',
      }),
    ).toEqual(['a.internal:9092', 'b.internal:9092']);
  });
});

describe('readPublicWebOrigin', () => {
  it('defaults outside production', () => {
    expect(readPublicWebOrigin({ NODE_ENV: 'development' })).toBe('http://localhost:3000');
  });

  it('refuses a production deployment with no origin rather than serve localhost links', () => {
    expect(() => readPublicWebOrigin({ NODE_ENV: 'production' })).toThrow(/PUBLIC_WEB_ORIGIN/);
  });

  it('keeps the origin alone, so a path or a trailing slash cannot double into a URL', () => {
    expect(
      readPublicWebOrigin({ NODE_ENV: 'production', PUBLIC_WEB_ORIGIN: 'https://arthome.fr/' }),
    ).toBe('https://arthome.fr');
  });
});

describe('readOpenSearchUrl', () => {
  it('defaults outside production', () => {
    expect(readOpenSearchUrl({ NODE_ENV: 'development' })).toBe('http://localhost:19200');
  });

  it('refuses a production deployment with no index URL instead of using localhost', () => {
    expect(() => readOpenSearchUrl({ NODE_ENV: 'production' })).toThrow(/OPENSEARCH_URL/);
  });
});

describe('readRedisUrl', () => {
  it('defaults outside production to the port compose.yaml publishes', () => {
    expect(readRedisUrl({ NODE_ENV: 'development' })).toBe('redis://localhost:56379');
  });

  it('refuses a production deployment with no REDIS_URL instead of using localhost', () => {
    expect(() => readRedisUrl({ NODE_ENV: 'production' })).toThrow(/REDIS_URL/);
  });

  it('accepts TLS, and refuses a URL that is not Redis', () => {
    expect(
      readRedisUrl({ NODE_ENV: 'production', REDIS_URL: 'rediss://cache.internal:6380/2' }),
    ).toBe('rediss://cache.internal:6380/2');
    expect(() =>
      readRedisUrl({ NODE_ENV: 'production', REDIS_URL: 'http://cache.internal:6379' }),
    ).toThrow(/REDIS_URL/);
  });
});

describe('readBffEnv', () => {
  it('points at the local catalog outside production', () => {
    expect(readBffEnv({ NODE_ENV: 'development', PORT: '3003' })).toEqual({
      NODE_ENV: 'development',
      PORT: 3003,
      CATALOG_URL: 'http://localhost:3002',
    });
  });

  it('refuses a production deployment with no CATALOG_URL', () => {
    expect(() => readBffEnv({ NODE_ENV: 'production', PORT: '3003' })).toThrow(/CATALOG_URL/);
  });
});

describe('readPaymentWebhookSecret', () => {
  it('defaults outside production, so the fake adapter verifies on a fresh clone', () => {
    expect(readPaymentWebhookSecret({ NODE_ENV: 'development' })).toHaveLength(34);
  });

  it('refuses a production deployment with no secret, and a secret too short to resist a guess', () => {
    expect(() => readPaymentWebhookSecret({ NODE_ENV: 'production' })).toThrow(
      /PAYMENT_WEBHOOK_SECRET/,
    );
    expect(() =>
      readPaymentWebhookSecret({ NODE_ENV: 'production', PAYMENT_WEBHOOK_SECRET: 'short' }),
    ).toThrow(/PAYMENT_WEBHOOK_SECRET/);
  });
});

describe('readPlaybackSigningKey', () => {
  const productionKey = JSON.stringify({
    ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }),
    kid: 'play-2026-10-06',
  });

  it('is the development playback key outside production, so the fake signs on a fresh clone', () => {
    expect(readPlaybackSigningKey({ NODE_ENV: 'development' }).keyId).toBe(
      DEVELOPMENT_PLAYBACK_KEY_ID,
    );
  });

  it('is never the internal token development key: the playback and session sets differ', () => {
    const playback = readPlaybackSigningKey({ NODE_ENV: 'test' }).privateJwk;

    expect(playback.x).not.toBe(DEVELOPMENT_TOKEN_PRIVATE_JWK.x);
    expect(playback.d).not.toBe(DEVELOPMENT_TOKEN_PRIVATE_JWK.d);
    expect(playback.kid).not.toBe(DEVELOPMENT_TOKEN_PRIVATE_JWK.kid);
  });

  it('is required in production, and both development keys are refused there under any kid', () => {
    expect(() => readPlaybackSigningKey({ NODE_ENV: 'production' })).toThrow(
      /PLAYBACK_SIGNING_KEY/,
    );
    for (const development of [DEVELOPMENT_PLAYBACK_PRIVATE_JWK, DEVELOPMENT_TOKEN_PRIVATE_JWK]) {
      expect(() =>
        readPlaybackSigningKey({
          NODE_ENV: 'production',
          PLAYBACK_SIGNING_KEY: JSON.stringify({ ...development, kid: 'play-2026-10-06' }),
        }),
      ).toThrow(/development key/);
    }
    expect(
      readPlaybackSigningKey({ NODE_ENV: 'production', PLAYBACK_SIGNING_KEY: productionKey }).keyId,
    ).toBe('play-2026-10-06');
  });

  it('refuses a key that is not a private P-256 JWK', () => {
    const { d: _private, ...publicHalf } = DEVELOPMENT_PLAYBACK_PRIVATE_JWK;

    expect(() =>
      readPlaybackSigningKey({
        NODE_ENV: 'test',
        PLAYBACK_SIGNING_KEY: JSON.stringify(publicHalf),
      }),
    ).toThrow();
    expect(() =>
      readPlaybackSigningKey({ NODE_ENV: 'test', PLAYBACK_SIGNING_KEY: 'not json' }),
    ).toThrow(/PLAYBACK_SIGNING_KEY is not JSON/);
  });
});

describe('readStreamKeySecret', () => {
  it('defaults outside production, so a stream key is derived on a fresh clone', () => {
    expect(readStreamKeySecret({ NODE_ENV: 'development' }).length).toBeGreaterThanOrEqual(32);
  });

  it('refuses in production no secret, a short one, and the development default', () => {
    const development = readStreamKeySecret({ NODE_ENV: 'development' });

    expect(() => readStreamKeySecret({ NODE_ENV: 'production' })).toThrow(/STREAM_KEY_SECRET/);
    expect(() =>
      readStreamKeySecret({ NODE_ENV: 'production', STREAM_KEY_SECRET: 'short' }),
    ).toThrow(/STREAM_KEY_SECRET/);
    expect(() =>
      readStreamKeySecret({ NODE_ENV: 'production', STREAM_KEY_SECRET: development }),
    ).toThrow(/development value/);
    expect(
      readStreamKeySecret({ NODE_ENV: 'production', STREAM_KEY_SECRET: 'x'.repeat(32) }),
    ).toHaveLength(32);
  });
});
