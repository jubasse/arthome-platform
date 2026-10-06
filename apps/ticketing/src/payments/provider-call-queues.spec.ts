import { JITTER_RATIO, RETRY_DELAYS_MS } from '@arthome-platform/messaging';
import type { Logger } from '@nestjs/common';
import type { Job, Worker } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { HOUR_MS } from '@arthome/core';

import { REFUND_RETRY_DELAYS_MS } from './owed-calls.js';
import {
  DEFAULT_PROVIDER_CALL_SCHEDULES,
  PROVIDER_CALL_BACKOFF,
  intentCancelKeyOf,
  isLastAttempt,
  jobIdOf,
  providerCallJobOptions,
  runOnSchedule,
  staleAfterMs,
} from './provider-call-queues.js';
import { refundKeyOf } from './refund-ledger.js';

const ID = '01a0f900-0000-7000-8000-000000000001';

/** A worker that records the backoff it is given and runs nothing. */
function idleWorker(): Worker {
  return { name: 'probe', opts: {}, run: () => Promise.resolve() } as unknown as Worker;
}

const silent = { error: () => undefined } as unknown as Logger;

function backoffOf(worker: Worker): (attemptsMade: number) => number {
  const strategy = worker.opts.settings?.backoffStrategy;
  if (strategy === undefined) throw new Error('no backoff strategy installed');
  return (attemptsMade) => strategy(attemptsMade) as number;
}

describe('the job id of a provider call', () => {
  it.each([
    ['a refund', `refund:${ID}`, `refund-${ID}`],
    ['a D-082 refund, under its order', refundKeyOf(ID), `refund-${ID}`],
    ["an intent's cancellation", intentCancelKeyOf(ID), `cancel-${ID}`],
  ])('is %s key with its colons made dashes: no colon, never an integer', (_, key, jobId) => {
    expect(jobIdOf(key)).toBe(jobId);
    expect(jobIdOf(key)).not.toContain(':');
    expect(jobIdOf(key)).not.toMatch(/^\d+$/);
    expect(jobIdOf(key)).toBe(jobIdOf(key));
  });
});

describe('the job options of a provider call', () => {
  it('allow one attempt more than its delays, on the custom backoff, and keep no job settled', () => {
    expect(providerCallJobOptions(REFUND_RETRY_DELAYS_MS)).toEqual({
      attempts: 28,
      backoff: { type: PROVIDER_CALL_BACKOFF },
      removeOnComplete: true,
      removeOnFail: true,
    });
    expect(providerCallJobOptions(RETRY_DELAYS_MS).attempts).toBe(4);
    expect(DEFAULT_PROVIDER_CALL_SCHEDULES).toEqual({
      refunds: REFUND_RETRY_DELAYS_MS,
      intentCancellations: RETRY_DELAYS_MS,
    });
  });

  it('know the last attempt by the job its options give', () => {
    const job = (attemptsMade: number) =>
      ({ attemptsMade, opts: { attempts: 4 } }) as unknown as Job;
    expect([0, 1, 2, 3].map((made) => isLastAttempt(job(made)))).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });
});

describe('the backoff a worker runs on', () => {
  it.each([
    ['a refund', REFUND_RETRY_DELAYS_MS],
    ["an intent's cancellation", RETRY_DELAYS_MS],
  ])(
    "waits each of %s's delays, within the consumers' jitter, and none after the last",
    (_, delays) => {
      const worker = idleWorker();
      runOnSchedule(worker, delays, silent);
      const backoff = backoffOf(worker);

      delays.forEach((delay, index) => {
        const wait = backoff(index + 1);
        expect(wait).toBeGreaterThanOrEqual(delay);
        expect(wait).toBeLessThanOrEqual(delay * (1 + JITTER_RATIO));
      });
      expect(backoff(delays.length + 1)).toBe(-1);
    },
  );
});

describe('the stale window', () => {
  it('outlasts each whole schedule with its jitter by an hour', () => {
    expect(staleAfterMs(REFUND_RETRY_DELAYS_MS) / HOUR_MS).toBeCloseTo(23.1, 1);
    expect(staleAfterMs(RETRY_DELAYS_MS) / HOUR_MS).toBeCloseTo(1.11, 2);
  });
});
