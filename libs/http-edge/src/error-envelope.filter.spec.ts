import {
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ApiErrorCode,
  DomainError,
  DomainErrorCode,
  FailureNature,
  FixedClock,
  IdentityErrorCode,
} from '@arthome/core';

import { ErrorEnvelopeFilter } from './error-envelope.filter.js';
import { RefusalException, type UniqueViolationCode } from './refusal.js';

const SERVED_AT = '2026-09-25T10:11:12.000Z';
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

/**
 * A stand-in shaped like `identity`'s table — the only real one, since `account` has
 * two `citext unique` columns and `catalog`'s `show` has none.
 *
 * ⚠ NOT THE SOURCE OF TRUTH, and copying it here is why this suite stayed green while
 *   the service passed no table at all. What identity actually binds is guarded by
 *   `apps/identity/src/unique-violations.spec.ts`, against its migrations.
 */
const IDENTITY_CONFLICTS: readonly UniqueViolationCode[] = [
  { column: 'public_handle', code: IdentityErrorCode.HANDLE_TAKEN },
  { column: 'email', code: IdentityErrorCode.EMAIL_TAKEN },
];

interface Sent {
  body?: unknown;
  status?: number;
}

/**
 * What the filter wrote to the log, captured rather than printed.
 *
 * ⚠ RECORDED BECAUSE HALF OF `nestjs-request-pipeline` RULE 6 IS ABOUT THE LOG, not
 *   the response: an unknown error must be LOGGED and answered generically. A suite
 *   that only asserts the response proves the silence and not the record, and a
 *   filter that swallowed everything would pass it. Capturing also keeps the run
 *   readable — a real `Logger` prints a stack trace through several of these.
 */
const logged: { level: string; message: string }[] = [];

Logger.overrideLogger({
  log: () => undefined,
  error: (message: unknown) => logged.push({ level: 'error', message: String(message) }),
  warn: (message: unknown) => logged.push({ level: 'warn', message: String(message) }),
});

beforeEach(() => {
  logged.length = 0;
});

function filterFor(
  headers: Record<string, string | undefined> = {},
  conflicts: readonly UniqueViolationCode[] = IDENTITY_CONFLICTS,
): { readonly run: (exception: unknown) => void; readonly sent: Sent } {
  const sent: Sent = {};
  const adapterHost = {
    httpAdapter: {
      reply: (_response: unknown, body: unknown, status: number) => {
        sent.body = body;
        sent.status = status;
      },
    },
  } as unknown as HttpAdapterHost;

  const host = {
    switchToHttp: () => ({ getRequest: () => ({ headers }), getResponse: () => ({}) }),
  } as unknown as ArgumentsHost;

  const filter = new ErrorEnvelopeFilter(adapterHost, new FixedClock(SERVED_AT), conflicts);
  return { run: (exception: unknown) => filter.catch(exception, host), sent };
}

/**
 * A `QueryFailedError` as TypeORM 1.1.1 really builds one: the pg error's own
 * properties copied onto the wrapper, `detail` included.
 *
 * The constraint name follows Postgres's own `{table}_{column}_key` rule, which is
 * what an inline `UNIQUE` produces — `account.public_handle` and `account.email` are
 * both declared that way in `1758700000000-initial.ts`.
 */
function uniqueViolation(constraint: string, column: string, value: string): Error {
  const driverError = Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    {
      code: '23505',
      constraint,
      table: 'account',
      detail: `Key (${column})=(${value}) already exists.`,
    },
  );
  return Object.assign(new Error(driverError.message), { ...driverError, driverError });
}

const emailCollision = (): Error =>
  uniqueViolation('account_email_key', 'email', 'marie@example.test');
const handleCollision = (): Error =>
  uniqueViolation('account_public_handle_key', 'public_handle', '@marie.j');

describe('ErrorEnvelopeFilter', () => {
  it('answers an email collision with 409 and the code that names it', () => {
    // ⚠ THE CODE NAMES THE SPECIFIC REFUSAL, which is the published contract's 409
    //   design: its 18 `Conflict` responses share one description reading "Definitive
    //   business refusal. The `code` says which one". Collapsing both columns into one
    //   generic code was the defect — a client could then tell a 409 from a 400 only
    //   by status.
    const { run, sent } = filterFor();
    run(emailCollision());

    expect(sent.status).toBe(HttpStatus.CONFLICT);
    expect(sent.body).toMatchObject({
      error: {
        code: IdentityErrorCode.EMAIL_TAKEN,
        nature: FailureNature.REFUSED,
        params: {},
      },
      servedAt: SERVED_AT,
    });
  });

  it('answers a handle collision with the handle code, never the email one', () => {
    // The false statement this exists to prevent. `account` has two unique columns and
    // one code for both would be wrong half the time.
    const { run, sent } = filterFor();
    run(handleCollision());

    expect(sent.status).toBe(HttpStatus.CONFLICT);
    expect(sent.body).toMatchObject({ error: { code: IdentityErrorCode.HANDLE_TAKEN } });
    expect(JSON.stringify(sent.body)).not.toContain('email');
  });

  it('matches the column inside the constraint name, so a rename does not silently fall through', () => {
    // Postgres names an inline UNIQUE `{table}_{column}_key`; a hand-named or
    // ORM-generated `UQ_account_email` means the same thing. The column is the fact,
    // the constraint name only its carrier.
    const { run, sent } = filterFor();
    run(uniqueViolation('UQ_account_email', 'email', 'marie@example.test'));
    expect(sent.body).toMatchObject({ error: { code: IdentityErrorCode.EMAIL_TAKEN } });
  });

  it('never serves the constraint name, the column or the value that collided', () => {
    // ⚠ THE SECURITY ASSERTION OF THIS FILE. `QueryFailedError` copies the driver
    //   error's properties onto itself, so its `message` is pg's "duplicate key value
    //   violates unique constraint …" and its `detail` is
    //   "Key (email)=(marie@example.test) already exists" — the column AND the
    //   person's address. Both are one spread of `getResponse()` away.
    const { run, sent } = filterFor();
    run(emailCollision());

    const served = JSON.stringify(sent.body);
    expect(served).not.toContain('account_email_key');
    expect(served).not.toContain('marie@example.test');
    expect(served).not.toContain('duplicate');
    expect(served).not.toContain('Key (');
  });

  it('logs the constraint and never the value, because that is where the column belongs', () => {
    // Server-side is where "which column" is useful and harmless. The pg `detail` is
    // deliberately not logged: a conflict is not a reason to copy someone's address
    // into a log file.
    const { run } = filterFor();
    run(emailCollision());

    expect(logged).toEqual([
      { level: 'warn', message: 'Unique violation on account_email_key; answered 409.' },
    ]);
    expect(logged[0]?.message).not.toContain('marie@example.test');
  });

  it('answers 500 and says so loudly when a unique violation has no declared code', () => {
    // ⚠ `catalog` PASSES NO TABLE, BECAUSE `show` HAS NO UNIQUE CONSTRAINT. A generic
    //   409 code was ruled out — the contract requires the code to name the refusal —
    //   so an unmapped violation is a gap in the service's own declaration, and the log
    //   line is what gets it written rather than discovered during an incident.
    const { run, sent } = filterFor({}, []);
    run(emailCollision());

    expect(sent.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(sent.body).toMatchObject({ error: { code: ApiErrorCode.INTERNAL } });
    expect(logged[0]?.level).toBe('error');
    expect(logged[0]?.message).toContain('no declared code');
    expect(JSON.stringify(sent.body)).not.toContain('marie@example.test');
  });

  it('serves the trace-id of the request that failed, so a log line can be found from the error screen', () => {
    const { run, sent } = filterFor({ traceparent: TRACEPARENT });
    run(emailCollision());
    expect(sent.body).toMatchObject({ error: { traceId: '4bf92f3577b34da6a3ce929d0e0e4736' } });
  });

  it('omits traceId rather than inventing one when no usable traceparent arrived', () => {
    // `ErrorSchema.traceId` is `z.string().min(1)`: an empty string would satisfy the
    // field's presence and send a reader looking for a log line that does not exist.
    const { run, sent } = filterFor({ traceparent: 'not-a-traceparent' });
    run(emailCollision());
    expect(sent.body).not.toHaveProperty('error.traceId');
  });

  it('serves a refusal with the code and parameters it was raised with', () => {
    const { run, sent } = filterFor();
    run(
      new RefusalException(HttpStatus.BAD_REQUEST, {
        code: ApiErrorCode.SCHEMA_INVALID,
        params: { fields: ['locale'] },
        nature: FailureNature.REFUSED,
      }),
    );

    expect(sent.status).toBe(HttpStatus.BAD_REQUEST);
    expect(sent.body).toMatchObject({
      error: {
        code: ApiErrorCode.SCHEMA_INVALID,
        params: { fields: ['locale'] },
        nature: FailureNature.REFUSED,
      },
    });
  });

  it('serves a domain error by reading it, because it already carries the three envelope fields', () => {
    // `DomainError` holds `code`, `params` and `nature` — exactly what §5.5 asks for —
    // so there is no translation table between the domain and the wire, and therefore
    // none to drift.
    const { run, sent } = filterFor();
    run(
      new DomainError({
        code: DomainErrorCode.MEDIA_SIZE_INVALID,
        params: { width: '0', height: '720' },
      }),
    );

    expect(sent.status).toBe(HttpStatus.BAD_REQUEST);
    expect(sent.body).toMatchObject({
      error: {
        code: DomainErrorCode.MEDIA_SIZE_INVALID,
        params: { width: '0', height: '720' },
        nature: FailureNature.REFUSED,
      },
    });
  });

  it('treats an unavailable domain error as 503, rather than blaming the caller', () => {
    const { run, sent } = filterFor();
    run(
      new DomainError({ code: DomainErrorCode.MEDIA_URL_EMPTY, nature: FailureNature.UNAVAILABLE }),
    );
    expect(sent.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it('gives a NestJS exception the same envelope, so the 400 and the 404 are one shape', () => {
    // §5.6 requires the boundary envelope to be one single shape, defined once. Before
    // this, the 400 was `{code, params, nature}` at the root and everything else was
    // `{statusCode, message}`.
    const { run, sent } = filterFor();
    run(new NotFoundException());

    expect(sent.status).toBe(HttpStatus.NOT_FOUND);
    expect(sent.body).toMatchObject({
      error: { code: ApiErrorCode.NOT_FOUND, nature: FailureNature.REFUSED, params: {} },
      servedAt: SERVED_AT,
    });
    expect(JSON.stringify(sent.body)).not.toContain('Not Found');
  });

  it('honours an errorCode a thrower set on a plain HTTP exception', () => {
    const { run, sent } = filterFor();
    run(new NotFoundException('gone', { errorCode: ApiErrorCode.CURSOR_TOO_OLD }));
    expect(sent.body).toMatchObject({ error: { code: ApiErrorCode.CURSOR_TOO_OLD } });
  });

  it('distinguishes 503 from 500, which one substitute code used to collapse', () => {
    // ⚠ THE DISTINCTION IS THE ONE A CALLER ACTS ON: 503 is retryable and 500 is not.
    //   Both answered `api.upstream_unavailable` until `api.internal` and
    //   `api.service_unavailable` were published, and that code means "a service behind
    //   the BFF failed" — false on our own crash, and it destroyed the distinction.
    const unavailable = filterFor();
    unavailable.run(new ServiceUnavailableException());
    expect(unavailable.sent.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(unavailable.sent.body).toMatchObject({
      error: { code: ApiErrorCode.SERVICE_UNAVAILABLE, nature: FailureNature.UNAVAILABLE },
    });

    const internal = filterFor();
    internal.run(new Error('anything'));
    expect(internal.sent.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(internal.sent.body).toMatchObject({
      error: { code: ApiErrorCode.INTERNAL, nature: FailureNature.UNAVAILABLE },
    });
  });

  it('never emits api.upstream_unavailable, which belongs to the BFF alone', () => {
    // It means "a service behind me failed". A service emitting it about itself is a
    // lie in the envelope, so no path here may produce it.
    for (const exception of [
      new Error('boom'),
      new ServiceUnavailableException(),
      new NotFoundException(),
      emailCollision(),
    ]) {
      const { run, sent } = filterFor();
      run(exception);
      expect(JSON.stringify(sent.body)).not.toContain(ApiErrorCode.UPSTREAM_UNAVAILABLE);
    }
  });

  it('says nothing at all about an unknown error', () => {
    const { run, sent } = filterFor();
    run(new Error('connect ECONNREFUSED 127.0.0.1:55432 password=hunter2'));

    expect(sent.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(sent.body).toMatchObject({
      error: { code: ApiErrorCode.INTERNAL, nature: FailureNature.UNAVAILABLE, params: {} },
    });
    const served = JSON.stringify(sent.body);
    expect(served).not.toContain('ECONNREFUSED');
    expect(served).not.toContain('hunter2');
    expect(served).not.toContain('55432');
  });

  it('logs the unknown error it refused to echo, so the silence is not a loss', () => {
    const { run } = filterFor();
    run(new Error('connect ECONNREFUSED 127.0.0.1:55432'));
    expect(logged).toEqual([{ level: 'error', message: 'Unhandled error; answered 500.' }]);
  });

  it('logs a status nobody declared a code for, rather than inventing one quietly', () => {
    // A bare `ConflictException` is the realistic case: a thrower who did not say which
    // refusal it was. The response is honest and the log is what gets the code written.
    const { run, sent } = filterFor();
    run(new HttpException('gone', HttpStatus.GONE));

    expect(sent.status).toBe(HttpStatus.GONE);
    expect(logged[0]?.message).toContain('No error code declared for status 410');
  });

  it('finds the SQLSTATE on driverError even when the ORM stops copying it upward', () => {
    // TypeORM 1.1.1 copies the driver error's properties onto the wrapper, so both
    // paths carry `23505` today. A version that stopped would silently turn every
    // conflict back into a 500.
    const { run, sent } = filterFor();
    run(
      Object.assign(new Error('wrapped'), {
        driverError: { code: '23505', constraint: 'account_email_key' },
      }),
    );
    expect(sent.status).toBe(HttpStatus.CONFLICT);
  });

  it('does not mistake another SQLSTATE for a conflict', () => {
    const { run, sent } = filterFor();
    run(Object.assign(new Error('not null violation'), { code: '23502' }));
    expect(sent.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it('stamps every response with servedAt, through the Clock port', () => {
    // critical-rules #9. Through the port and never `new Date()`: a filter that read
    // the machine's time could not be asserted on at all.
    const { run, sent } = filterFor();
    run(new Error('anything'));
    expect(sent.body).toMatchObject({ servedAt: SERVED_AT });
  });
});
