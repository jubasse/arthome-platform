import { RefusalException } from '@arthome-platform/http-edge';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiErrorCode, FixedClock } from '@arthome/core';

import { runIdempotently, type IdempotentRequest } from './idempotency.js';
import { Idempotency1790420000000 } from '../migrations/1790420000000-idempotency.js';
import { IdempotencyResponseAsJson1790420500000 } from '../migrations/1790420500000-idempotency-response-as-json.js';

/**
 * The store against a real Postgres: what makes a concurrent retry wait, replay or give up is
 * the unique constraint and `lock_timeout`, which no fake reproduces.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const clock = new FixedClock('2026-09-26T10:00:00.000Z');

let stack: StartedStack;
let dataSource: DataSource;

function request(key: string, fingerprint = 'fingerprint-a'): IdempotentRequest {
  return { key, accountId: null, fingerprint, statusCode: 201 };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function refusalOf(attempt: Promise<unknown>): Promise<RefusalException> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof RefusalException) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'catalog_idempotency_itest');
  dataSource = await applyMigrations(database, {
    entities: [],
    migrations: [Idempotency1790420000000, IdempotencyResponseAsJson1790420500000],
  });
}, STARTUP_MS);

afterAll(async () => {
  await dataSource?.destroy();
  await stack?.stop();
});

describe('an idempotent command against a real Postgres', () => {
  it(
    'runs once, then replays the memorised envelope without running again',
    async () => {
      let runs = 0;
      const key = '01a0e000-0000-7000-8000-000000000001';

      const first = await dataSource.transaction((manager) =>
        runIdempotently(manager, request(key), clock, () => {
          runs += 1;
          return Promise.resolve({ dateId: 'date-1' });
        }),
      );
      const again = await dataSource.transaction((manager) =>
        runIdempotently(manager, request(key), clock, () => {
          runs += 1;
          return Promise.resolve({ dateId: 'date-2' });
        }),
      );

      expect(first.replayed).toBe(false);
      expect(again.replayed).toBe(true);
      // Serialised, because `toEqual` ignores key order and the replay must be byte for byte.
      expect(JSON.stringify(again.envelope)).toBe(JSON.stringify(first.envelope));
      expect(runs).toBe(1);
    },
    CASE_MS,
  );

  it(
    'refuses the same key sent with another body, and runs nothing',
    async () => {
      const key = '01a0e000-0000-7000-8000-000000000002';
      await dataSource.transaction((manager) =>
        runIdempotently(manager, request(key), clock, () => Promise.resolve({ ok: true })),
      );

      let ran = false;
      const refusal = await refusalOf(
        dataSource.transaction((manager) =>
          runIdempotently(manager, request(key, 'fingerprint-b'), clock, () => {
            ran = true;
            return Promise.resolve({ ok: false });
          }),
        ),
      );

      expect(refusal.getStatus()).toBe(409);
      expect(refusal.refusal.code).toBe(ApiErrorCode.IDEMPOTENCY_KEY_REUSED);
      expect(ran).toBe(false);
    },
    CASE_MS,
  );

  it(
    'makes a concurrent attempt wait for the first, then replay it',
    async () => {
      const key = '01a0e000-0000-7000-8000-000000000003';
      const started = deferred();
      const release = deferred();
      let runs = 0;

      const first = dataSource.transaction((manager) =>
        runIdempotently(manager, request(key), clock, async () => {
          runs += 1;
          started.resolve();
          await release.promise;
          return { attempt: 1 };
        }),
      );
      await started.promise;
      const second = dataSource.transaction((manager) =>
        runIdempotently(manager, request(key), clock, () => {
          runs += 1;
          return Promise.resolve({ attempt: 2 });
        }),
      );
      setTimeout(release.resolve, 300);

      const [a, b] = await Promise.all([first, second]);
      expect(a.replayed).toBe(false);
      expect(b.replayed).toBe(true);
      expect(b.envelope).toEqual(a.envelope);
      expect(runs).toBe(1);
    },
    CASE_MS,
  );

  it(
    'tells a retry the first attempt is still running once its wait runs out',
    async () => {
      const key = '01a0e000-0000-7000-8000-000000000004';
      const started = deferred();
      const release = deferred();

      const first = dataSource.transaction((manager) =>
        runIdempotently(manager, request(key), clock, async () => {
          started.resolve();
          await release.promise;
          return { attempt: 1 };
        }),
      );
      await started.promise;

      const refusal = await refusalOf(
        dataSource.transaction((manager) =>
          runIdempotently(manager, request(key), clock, () => Promise.resolve({ attempt: 2 })),
        ),
      );
      release.resolve();
      await first;

      expect(refusal.getStatus()).toBe(409);
      expect(refusal.refusal.code).toBe(ApiErrorCode.IDEMPOTENCY_IN_FLIGHT);
      expect(refusal.refusal.params).toEqual({ retryAfterMs: 1_000 });
    },
    CASE_MS,
  );

  it(
    'lets the key run again when the first attempt rolled back',
    async () => {
      const key = '01a0e000-0000-7000-8000-000000000005';
      await expect(
        dataSource.transaction((manager) =>
          runIdempotently(manager, request(key), clock, () => Promise.reject(new Error('boom'))),
        ),
      ).rejects.toThrow('boom');

      const retried = await dataSource.transaction((manager) =>
        runIdempotently(manager, request(key), clock, () => Promise.resolve({ attempt: 2 })),
      );

      expect(retried.replayed).toBe(false);
      expect(retried.envelope.data).toEqual({ attempt: 2 });
    },
    CASE_MS,
  );
});
