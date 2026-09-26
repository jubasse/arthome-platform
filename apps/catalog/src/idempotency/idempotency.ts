import { createHash } from 'node:crypto';

import {
  MemorisedResponse,
  RefusalException,
  schemaInvalidException,
  type SuccessEnvelope,
} from '@arthome-platform/http-edge';
import { HttpStatus } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';

import { ApiErrorCode, FailureNature, type Clock } from '@arthome/core';

/** transport.md §5.4. */
export const IDEMPOTENCY_KEY_LIFETIME_HOURS = 24;

// How long a retry waits for the first attempt's transaction before being told it is in flight.
const FIRST_ATTEMPT_WAIT_MS = 5_000;
const RETRY_AFTER_MS = 1_000;

const LOCK_NOT_AVAILABLE = '55P03';

export interface IdempotentRequest {
  readonly key: string;
  /**
   * Null until tokens are verified (adr-auth.md defers it): unauthenticated callers then share
   * one scope, which only a non-production deployment can reach.
   */
  readonly accountId: string | null;
  readonly fingerprint: string;
  readonly statusCode: number;
}

interface StoredRecord {
  readonly fingerprint: string;
  readonly state: 'in_flight' | 'completed';
  readonly response_body: SuccessEnvelope<unknown> | null;
}

/** Required, and a UUID; a missing or malformed key is a schema fault naming the header. */
export function idempotencyKeyOf(header: string | undefined): string {
  const parsed = z.uuid().safeParse(header);
  if (!parsed.success) throw schemaInvalidException([{ path: ['Idempotency-Key'] }]);
  return parsed.data;
}

/** Method, path and the validated body: transport.md §5.4's fingerprint. */
export function fingerprintOf(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([method, path, body]))
    .digest('hex');
}

/**
 * transport.md §5.4 inside the command's own transaction. The record is inserted first, so a
 * second attempt with the same key waits on it; it is completed with the envelope before the
 * commit, so no crash can leave an effect without its response.
 */
export async function runIdempotently<T>(
  manager: EntityManager,
  request: IdempotentRequest,
  clock: Clock,
  command: () => Promise<T>,
): Promise<MemorisedResponse<T>> {
  if (!(await claim(manager, request))) return replay<T>(manager, request);

  const envelope: SuccessEnvelope<T> = { servedAt: clock.now(), data: await command() };
  await manager.query(
    `UPDATE idempotency_record
        SET state = 'completed', status_code = $3, response_body = $4
      WHERE account_id IS NOT DISTINCT FROM $1 AND key = $2`,
    [request.accountId, request.key, request.statusCode, JSON.stringify(envelope)],
  );
  return new MemorisedResponse(envelope, false);
}

async function claim(manager: EntityManager, request: IdempotentRequest): Promise<boolean> {
  await manager.query(`SET LOCAL lock_timeout = ${FIRST_ATTEMPT_WAIT_MS}`);
  let claimed: unknown[];
  try {
    claimed = await manager.query<unknown[]>(
      `INSERT INTO idempotency_record (key, account_id, fingerprint, state, expires_at)
       VALUES ($1, $2, $3, 'in_flight', now() + ($4 || ' hours')::interval)
       ON CONFLICT ON CONSTRAINT idempotency_record_scope DO NOTHING
       RETURNING key`,
      [request.key, request.accountId, request.fingerprint, String(IDEMPOTENCY_KEY_LIFETIME_HOURS)],
    );
  } catch (error) {
    if (postgresCodeOf(error) === LOCK_NOT_AVAILABLE) throw inFlight();
    throw error;
  }
  await manager.query('SET LOCAL lock_timeout = DEFAULT');
  return claimed.length === 1;
}

async function replay<T>(
  manager: EntityManager,
  request: IdempotentRequest,
): Promise<MemorisedResponse<T>> {
  const [stored] = await manager.query<StoredRecord[]>(
    `SELECT fingerprint, state, response_body FROM idempotency_record
      WHERE account_id IS NOT DISTINCT FROM $1 AND key = $2`,
    [request.accountId, request.key],
  );

  // Absent means purged between the conflict and this read; either way, try again shortly.
  if (stored?.state !== 'completed' || stored.response_body === null) throw inFlight();
  if (stored.fingerprint !== request.fingerprint) {
    throw new RefusalException(HttpStatus.CONFLICT, {
      code: ApiErrorCode.IDEMPOTENCY_KEY_REUSED,
      params: {},
      nature: FailureNature.REFUSED,
    });
  }
  return new MemorisedResponse(stored.response_body as SuccessEnvelope<T>, true);
}

function inFlight(): RefusalException {
  return new RefusalException(HttpStatus.CONFLICT, {
    code: ApiErrorCode.IDEMPOTENCY_IN_FLIGHT,
    params: { retryAfterMs: RETRY_AFTER_MS },
    nature: FailureNature.UNAVAILABLE,
  });
}

function postgresCodeOf(error: unknown): string | undefined {
  const withDriver = error as { driverError?: { code?: unknown }; code?: unknown };
  const code = withDriver.driverError?.code ?? withDriver.code;
  return typeof code === 'string' ? code : undefined;
}
