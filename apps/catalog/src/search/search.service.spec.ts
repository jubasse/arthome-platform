import { RefusalException } from '@arthome-platform/http-edge';
import { errors, type Client } from '@opensearch-project/opensearch';
import { describe, expect, it } from 'vitest';

import { ApiErrorCode, FixedClock } from '@arthome/core';

import { SearchQuerySchema } from './search-query.schema.js';
import { SearchService } from './search.service.js';

/** A query that only ends when aborted, returning itself from `abort()` as the client does. */
function hangingQuery(): Promise<never> & { abort(): unknown } {
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_, onRejected) => {
    reject = onRejected;
  });
  const query = Object.assign(pending, {
    abort: () => {
      reject(new errors.RequestAbortedError('Request aborted', undefined));
      return query;
    },
  });
  return query;
}

describe('SearchService', () => {
  it('stops the query when the caller leaves, and answers without an uncaught rejection', async () => {
    const uncaught: unknown[] = [];
    const record = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on('uncaughtException', record);
    try {
      const client = { search: () => hangingQuery() } as unknown as Client;
      const service = new SearchService(client, new FixedClock('2026-09-27T10:00:00.000Z'));
      const caller = new AbortController();

      const search = service.search(SearchQuerySchema.parse({ q: 'nuit' }), 1_000, caller.signal);
      caller.abort();

      const refusal = await search.catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(RefusalException);
      expect((refusal as RefusalException).refusal.code).toBe(ApiErrorCode.DEADLINE_EXCEEDED);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', record);
    }
  });
});
