import { describe, expect, it } from 'vitest';

import {
  isProductionEnvironment,
  readKafkaBrokers,
  readBffEnv,
  readOpenSearchUrl,
  readPublicWebOrigin,
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
