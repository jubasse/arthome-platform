import { createHash, createHmac } from 'node:crypto';

import type { EntityManager } from 'typeorm';
import { z } from 'zod';

import { ApiErrorCode, type Clock } from '@arthome/core';

import { refusalOf, schemaInvalidException, type RefusalException } from './refusal.js';
import { MemorisedResponse, type SuccessEnvelope } from './success-envelope.interceptor.js';

/** transport.md §5.4. */
export const IDEMPOTENCY_KEY_LIFETIME_HOURS = 24;

// How long a retry waits for the first attempt's transaction before being told it is in flight.
const FIRST_ATTEMPT_WAIT_MS = 5_000;
const RETRY_AFTER_MS = 1_000;

const LOCK_NOT_AVAILABLE = '55P03';

/** The claim's `ON CONFLICT` names it, so the table and the claim read it from here. */
const SCOPE_CONSTRAINT = 'idempotency_record_scope';

/**
 * transport.md §5.4's store, for a new service's migration. Its primary key is
 *   `(account_id, key)`; here a unique constraint with NULLS NOT DISTINCT, because `account_id`
 *   is null for an anonymous visitor's request. `response_body` is `json`, not `jsonb`: a replay answers
 *   the first response byte for byte, and `jsonb` reorders an object's keys.
 */
export function idempotencyRecordTableDdl(): string {
  return `
    CREATE TABLE idempotency_record (
      key           text        NOT NULL,
      account_id    uuid        NULL,
      fingerprint   text        NOT NULL,
      state         text        NOT NULL CHECK (state IN ('in_flight', 'completed')),
      status_code   integer     NULL,
      response_body json        NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      expires_at    timestamptz NOT NULL,
      CONSTRAINT ${SCOPE_CONSTRAINT} UNIQUE NULLS NOT DISTINCT (account_id, key)
    );
    CREATE INDEX idx_idempotency_record_expires_at ON idempotency_record (expires_at)
  `;
}

/**
 * The retention job's half of §5.4: a record past its 24 hours answers nothing any more, and a
 *   kept one holds a response for as long as it stays. Run by `tools/purge-retention.mjs`.
 */
export async function purgeIdempotencyRecords(
  queryable: Pick<EntityManager, 'query'>,
): Promise<number> {
  const result: unknown = await queryable.query(
    'DELETE FROM idempotency_record WHERE expires_at < now()',
  );
  // pg answers [rows, rowCount] for a DELETE.
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}

export interface IdempotentRequest {
  readonly key: string;
  /**
   * The internal token's account, so one account's key never answers another's request. Null for
   * an anonymous visitor (a sign-up), whose keys share one scope: a replay there still needs the
   * same fingerprint.
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
  if (!parsed.success) {
    throw schemaInvalidException(
      parsed.error.issues.map((issue) => ({ ...issue, path: ['Idempotency-Key'] })),
    );
  }
  return parsed.data;
}

/** Method, path and the validated body: transport.md §5.4's fingerprint. */
export function fingerprintOf(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([method, path, body]))
    .digest('hex');
}

/**
 * The fingerprint of a body that carries a secret, a password: keyed, so the stored record is no
 *   unsalted hash of it for a day.
 */
export function keyedFingerprintOf(
  secret: string,
  method: string,
  path: string,
  body: unknown,
): string {
  return createHmac('sha256', secret)
    .update(JSON.stringify([method, path, body]))
    .digest('hex');
}

/** `statusCode` is the one the route answers, which a replay answers again. */
export function idempotentRequestOf(
  method: string,
  path: string,
  body: unknown,
  statusCode: number,
  idempotencyKey: string | undefined,
  accountId: string | null,
): IdempotentRequest {
  return {
    key: idempotencyKeyOf(idempotencyKey),
    accountId,
    fingerprint: fingerprintOf(method, path, body),
    statusCode,
  };
}

/**
 * transport.md §5.4 inside the command's own transaction. The record is inserted first, so a
 * second attempt with the same key waits on it; it is completed with the envelope before the
 * commit, so no crash can leave an effect without its response.
 */
export function runIdempotently<T>(
  manager: EntityManager,
  request: IdempotentRequest,
  clock: Clock,
  command: () => Promise<T>,
): Promise<MemorisedResponse<T>> {
  return runEnveloped(manager, request, async () => {
    const servedAt = clock.now();
    return { servedAt, data: await command() };
  });
}

/** For a command whose answer carries the aggregate's new `version` at the envelope's root. */
export function runIdempotentlyVersioned<T>(
  manager: EntityManager,
  request: IdempotentRequest,
  clock: Clock,
  command: () => Promise<{ readonly data: T; readonly version: number }>,
): Promise<MemorisedResponse<T>> {
  return runEnveloped(manager, request, async () => {
    const servedAt = clock.now();
    const { data, version } = await command();
    return { servedAt, version, data };
  });
}

async function runEnveloped<T>(
  manager: EntityManager,
  request: IdempotentRequest,
  envelopeOf: () => Promise<SuccessEnvelope<T>>,
): Promise<MemorisedResponse<T>> {
  if (!(await claim(manager, request))) return replay<T>(manager, request);

  const envelope = await envelopeOf();
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
       ON CONFLICT ON CONSTRAINT ${SCOPE_CONSTRAINT} DO NOTHING
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
    throw refusalOf(ApiErrorCode.IDEMPOTENCY_KEY_REUSED);
  }
  return new MemorisedResponse(stored.response_body as SuccessEnvelope<T>, true);
}

function inFlight(): RefusalException {
  return refusalOf(ApiErrorCode.IDEMPOTENCY_IN_FLIGHT, { retryAfterMs: RETRY_AFTER_MS });
}

function postgresCodeOf(error: unknown): string | undefined {
  const withDriver = error as { driverError?: { code?: unknown }; code?: unknown };
  const code = withDriver.driverError?.code ?? withDriver.code;
  return typeof code === 'string' ? code : undefined;
}
