import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { SignInSlowdown, signInDelayMs } from '@arthome/core';

import { normalisedEmail } from './auth-rate-limits.js';
import { THROTTLER_REDIS } from './throttler-storage.js';

export type Pause = (ms: number) => Promise<void>;

export const PAUSE: unique symbol = Symbol('Pause');

export const pauseFor: Pause = async (ms) => {
  if (ms > 0) await sleep(ms);
};

/** Hashed, so the counters name no address in Redis. */
function keyOf(email: string): string {
  return `sign-in-failures:${createHash('sha256').update(normalisedEmail(email)).digest('hex')}`;
}

/**
 * The per-email defence against password guessing (`adr-auth.md` §6.2, no lockout per email): an
 *   email's recent failures, from any network, hold its next attempt for a bounded pause and never
 *   refuse it, so a stranger can slow an owner by four seconds at most, never sign them out.
 */
@Injectable()
export class FailedSignIns {
  public constructor(
    @Inject(THROTTLER_REDIS) private readonly redis: Redis,
    @Inject(PAUSE) private readonly pause: Pause,
  ) {}

  public async holdBefore(email: string): Promise<void> {
    const failures = Number((await this.redis.get(keyOf(email))) ?? 0);
    await this.pause(signInDelayMs(failures));
  }

  public async count(email: string): Promise<void> {
    const key = keyOf(email);
    await this.redis.multi().incr(key).expire(key, SignInSlowdown.WINDOW_SECONDS).exec();
  }

  public async forget(email: string): Promise<void> {
    await this.redis.del(keyOf(email));
  }
}
