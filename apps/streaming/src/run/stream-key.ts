import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { EntityManager } from 'typeorm';

import type { Instant } from '@arthome/core';

/** The secret stream keys derive from (`readStreamKeySecret`): a token, so a suite binds its own. */
export const STREAM_KEY_SECRET: unique symbol = Symbol('StreamKeySecret');

export const FIRST_STREAM_KEY_GENERATION = 1;

const STREAM_PATH_BYTES = 16;

/** 128 random bits: a path nobody can guess, so knowing a date reaches no feed (ADR §3.2). */
export function newStreamPath(): string {
  return randomBytes(STREAM_PATH_BYTES).toString('base64url');
}

/**
 * Derived, never stored (`data-model.md` §5.2): the table keeps its digest alone, and the key
 *   appears in no list, event, log or console. The secret and the generation give it back.
 */
export function streamKeyOf(secret: string, runId: string, generation: number): string {
  return createHmac('sha256', secret).update(`${runId}:${generation}`).digest('base64url');
}

export function streamKeyDigestOf(key: string): string {
  return createHash('sha256').update(key).digest('base64url');
}

/** Constant time over two digests of one length, so a refusal says nothing about how close it was. */
export function digestsMatch(presentedDigest: string, storedDigest: string): boolean {
  const presented = Buffer.from(presentedDigest);
  const stored = Buffer.from(storedDigest);
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

export async function insertStreamKey(
  manager: EntityManager,
  secret: string,
  runId: string,
  generation: number,
  now: Instant,
): Promise<void> {
  await manager.query(
    `INSERT INTO stream_key (run_id, generation, digest, created_at) VALUES ($1, $2, $3, $4)`,
    [runId, generation, streamKeyDigestOf(streamKeyOf(secret, runId, generation)), new Date(now)],
  );
}
