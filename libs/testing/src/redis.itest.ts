import { Redis } from 'ioredis';
import { afterAll, describe, expect, inject, it } from 'vitest';

import { PROVIDED_REDIS_URL, flushRedisDatabase, workerRedisUrl } from './redis.js';

const TEST_BUDGET_MS = 60_000;

/** The run's one Redis, started by `vitest.redis-setup.mjs` before any file. */
const serverUrl = inject(PROVIDED_REDIS_URL);

const clients: Redis[] = [];

function client(url: string): Redis {
  const opened = new Redis(url, { maxRetriesPerRequest: 1 });
  clients.push(opened);
  return opened;
}

afterAll(() => {
  for (const opened of clients) opened.disconnect();
});

describe('the run’s Redis', () => {
  it(
    'is configured as compose.yaml configures it: no eviction, an append-only file',
    async () => {
      const redis = client(serverUrl);

      expect(await redis.config('GET', 'maxmemory-policy')).toEqual([
        'maxmemory-policy',
        'noeviction',
      ]);
      expect(await redis.config('GET', 'appendonly')).toEqual(['appendonly', 'yes']);
    },
    TEST_BUDGET_MS,
  );

  it(
    'gives each worker its own database, which a flush empties alone',
    async () => {
      const mine = workerRedisUrl(serverUrl);
      const another = workerRedisUrl(serverUrl, '15');
      expect(mine).not.toBe(another);
      await client(mine).set('probe', 'mine');
      await client(another).set('probe', 'another');

      await flushRedisDatabase(mine);

      expect(await client(mine).get('probe')).toBeNull();
      expect(await client(another).get('probe')).toBe('another');
      await flushRedisDatabase(another);
    },
    TEST_BUDGET_MS,
  );
});
