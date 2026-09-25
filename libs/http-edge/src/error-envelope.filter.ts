import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import { FailureNature, isDomainError, type Clock, type DomainError } from '@arthome/core';

import {
  isMappedStatus,
  refusalForStatus,
  RefusalException,
  type Refusal,
  type UniqueViolationCode,
} from './refusal.js';
import { parseTraceparent } from './traceparent.js';

/**
 * Postgres's `unique_violation` — the one failure a service provokes on a well-formed
 * request, and the reason this filter exists. Measured: a duplicate `email` in `identity`
 * left as `{"statusCode":500,"message":"Internal server error"}` — wrong status, nothing to
 * branch on, and a 500-versus-201 oracle answering "is this address registered?" to anyone
 * who can reach the port.
 */
const UNIQUE_VIOLATION = '23505';

/** The error envelope, exactly as `transport.md` §5.5 specifies it. */
interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly nature: FailureNature;
    readonly params: Readonly<Record<string, unknown>>;
    /** Absent when the request carried no usable `traceparent` — never invented. */
    readonly traceId?: string;
  };
  readonly servedAt: string;
}

/**
 * The single place an error becomes a response — a library rather than a file per service,
 * because two copies of one envelope is critical-rules #2.
 *
 * ⚠ It replies through `httpAdapter.reply`, not `response.status().json()`: on
 *   `@nestjs/platform-fastify` the Express idiom throws "response.status is not a function".
 * ⚠ `@Catch()` with no argument, and the only filter. A catch-all must be registered BEFORE
 *   any specific one — NestJS reverses the list and the first match wins — so the status
 *   mapping is a lookup inside it rather than a second filter with an order to get wrong.
 */
@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorEnvelopeFilter.name);

  /**
   * An empty `uniqueViolationCodes` is legitimate — `catalog`'s `show` has no unique
   * constraint — and an unmapped violation is logged as a gap rather than given a generic
   * code, because the contract's 409 design is that the code names the specific refusal.
   */
  public constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly clock: Clock,
    private readonly uniqueViolationCodes: readonly UniqueViolationCode[] = [],
  ) {}

  public catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<{ headers: Record<string, string | undefined> }>();
    const trace = parseTraceparent(request.headers.traceparent);

    const { status, refusal } = this.resolve(exception);

    const envelope: ErrorEnvelope = {
      error: {
        code: refusal.code,
        nature: refusal.nature,
        params: refusal.params,
        // ⚠ Omitted rather than empty: `ErrorSchema.traceId` is `z.string().min(1)`, so an
        //   empty string would satisfy the field's presence and lead a reader to a log line
        //   that does not exist. `exactOptionalPropertyTypes` is why this is a spread.
        ...(trace === null ? {} : { traceId: trace.traceId }),
      },
      // Through the `Clock` port, never `new Date()`: a filter that reads the machine's time
      // cannot be asserted on (critical-rules #9 and #6).
      servedAt: this.clock.now(),
    };

    this.adapterHost.httpAdapter.reply(context.getResponse(), envelope, status);
  }

  /** The status and refusal to serve, in the order the cases must be tried. */
  private resolve(exception: unknown): { status: number; refusal: Refusal } {
    if (exception instanceof RefusalException) {
      return { status: exception.getStatus(), refusal: exception.refusal };
    }

    // ⚠ No translation table needed: `DomainError` already carries `code`, `params` and
    //   `nature`. The domain throws these rather than `HttpException`s because a rule in
    //   `@arthome/core` is reachable from seven services and must not know its transport.
    if (isDomainError(exception)) {
      return { status: statusForDomainError(exception), refusal: exception };
    }

    if (postgresErrorCodeOf(exception) === UNIQUE_VIOLATION) {
      return this.resolveUniqueViolation(constraintNameOf(exception));
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (exception.errorCode === undefined && !isMappedStatus(status)) {
        // A status nobody designed a code for. The response is honest rather than invented,
        // and the log is what gets the mapping written.
        this.logger.error(
          `No error code declared for status ${String(status)}; answered it anyway.`,
        );
      }
      const fallback = refusalForStatus(status);
      return {
        status,
        // `getResponse()` is NOT spread in: for a built-in exception it holds an English
        // `message`, which §5.5 forbids.
        refusal: { ...fallback, code: exception.errorCode ?? fallback.code },
      };
    }

    // ⚠ An unknown error's message carries SQL, connection strings and stack frames, so it
    //   may not be echoed. `Logger.error` takes the error so the stack survives.
    this.logger.error('Unhandled error; answered 500.', exception);
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      refusal: refusalForStatus(HttpStatus.INTERNAL_SERVER_ERROR),
    };
  }

  /**
   * ⚠ The constraint name is read, logged, and never served. It must be read because the 409
   *   design is that the code names the SPECIFIC refusal — `identity.email_taken` for one
   *   column, `identity.handle_taken` for the other. What must not travel is the rest:
   *   `QueryFailedError` copies the driver error's properties onto itself, so its `detail` is
   *   "Key (email)=(someone@example.test) already exists" — the column AND the value. Only
   *   the code leaves; only the constraint name is logged, never `detail`.
   * ⚠ It matches the column INSIDE the name rather than the whole name: Postgres names inline
   *   `UNIQUE`s `{table}_{column}_key`, and a later hand-named or ORM-generated
   *   `UQ_account_email` would break an exact match while meaning the same thing.
   *   `public_handle` and `email` do not overlap. Not verified against a running Postgres —
   *   check this first when the event-path walkthrough is next run.
   * ⚠ `detail` would also name the column and is deliberately not used for it: pg translates
   *   `detail` under `lc_messages`, while constraint names are never translated.
   */
  private resolveUniqueViolation(constraint: string | null): { status: number; refusal: Refusal } {
    const matched = this.uniqueViolationCodes.find(
      (candidate) => constraint?.includes(candidate.column) === true,
    );

    if (matched === undefined) {
      this.logger.error(
        `Unique violation on ${constraint ?? 'an unnamed constraint'} with no declared code; ` +
          'answered 500. Declare its column where this filter is bound.',
      );
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        refusal: refusalForStatus(HttpStatus.INTERNAL_SERVER_ERROR),
      };
    }

    this.logger.warn(`Unique violation on ${constraint ?? 'an unnamed constraint'}; answered 409.`);
    return {
      status: HttpStatus.CONFLICT,
      refusal: { code: matched.code, params: {}, nature: FailureNature.REFUSED },
    };
  }
}

/**
 * ⚠ The per-code table §5.5 calls for does not exist and is not invented here: it belongs
 *   "single, in `@arthome/contracts`" and neither service depends on that package. Nature
 *   alone cannot choose — `refused` covers 400, 401, 403, 404, 409 and 410 — and 400 is the
 *   least wrong default for a refusal the caller's own input provoked.
 */
function statusForDomainError(error: DomainError): number {
  return error.nature === FailureNature.REFUSED
    ? HttpStatus.BAD_REQUEST
    : HttpStatus.SERVICE_UNAVAILABLE;
}

/**
 * ⚠ Duck-typed rather than `instanceof QueryFailedError`, so the transport layer does not
 *   depend on the ORM for one `instanceof`. TypeORM 1.1.1 keeps the pg error on `driverError`
 *   and also copies its enumerable properties onto the wrapper; `driverError` is read first
 *   because it is authoritative — a version that stopped copying would silently turn every
 *   conflict back into a 500.
 */
function postgresErrorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  if ('driverError' in error) {
    const nested = postgresErrorCodeOf(error.driverError);
    if (nested !== null) {
      return nested;
    }
  }
  return 'code' in error && typeof error.code === 'string' ? error.code : null;
}

function constraintNameOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  if ('constraint' in error && typeof error.constraint === 'string') {
    return error.constraint;
  }
  return 'driverError' in error ? constraintNameOf(error.driverError) : null;
}
