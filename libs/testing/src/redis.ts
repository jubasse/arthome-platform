import { Redis } from 'ioredis';
import type { TestProject } from 'vitest/node';

import { startStack } from './stack.js';

/** The key a test reads the run's Redis under: `inject(PROVIDED_REDIS_URL)`. */
export const PROVIDED_REDIS_URL = 'arthomeRedisUrl';

declare module 'vitest' {
  export interface ProvidedContext {
    arthomeRedisUrl: string;
  }
}

/** Redis' default count: indexes 0 to 15. */
const DATABASES = 16;

/**
 * A Vitest `globalSetup`: one Redis for the whole run, never one per file or per test
 *   (`nestjs-testing` rule 11). The returned function is the teardown.
 */
export async function provideRedisForRun(project: TestProject): Promise<() => Promise<void>> {
  const stack = await startStack({ redis: true });
  project.provide(PROVIDED_REDIS_URL, stack.redis.url);
  return () => stack.stop();
}

/**
 * This worker's database on the run's Redis, so `flushRedisDatabase` between tests wipes no other
 *   worker's keys. `VITEST_POOL_ID` counts from 1, which caps a run at 15 workers.
 */
export function workerRedisUrl(
  serverUrl: string,
  poolId: string | undefined = process.env.VITEST_POOL_ID,
): string {
  const database = Number(poolId ?? '1');
  if (!Number.isInteger(database) || database < 1 || database >= DATABASES) {
    throw new Error(
      `worker ${String(poolId)} has no Redis database of its own: there are ${DATABASES - 1} ` +
        'for workers, so cap `maxWorkers` at that or give each worker a key prefix.',
    );
  }
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** `FLUSHDB` on the URL's database alone; never `FLUSHALL`, which empties every worker's. */
export async function flushRedisDatabase(url: string): Promise<void> {
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await client.connect();
    await client.flushdb();
  } finally {
    client.disconnect();
  }
}
