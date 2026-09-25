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
 * Postgres's `unique_violation` — the one failure a service provokes on a perfectly
 * well-formed request, and the reason this filter exists. Before it, a duplicate
 * `email` or `public_handle` in `identity` left as
 * `{"statusCode":500,"message":"Internal server error"}`: wrong status, nothing to
 * branch on, and a 500-versus-201 difference answering "is this address registered?"
 * to anyone who can reach the port.
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
 * The single place an error becomes a response.
 *
 * ⚠ ONE SHAPE, AND UNTIL NOW THERE WERE TWO. `catalog` answered a bad
 *   `languageDependency` with `{code, params, nature}` at the root and everything else
 *   with NestJS's `{statusCode, message}` — and §5.6 requires the boundary envelope to
 *   be "one single shape, defined once". That "defined once" is also why this is a
 *   library rather than a file in each service: two copies of one envelope is
 *   critical-rules #2, "two calls are allowed, two implementations never".
 *
 * ⚠ IT REPLIES THROUGH `httpAdapter.reply`, NOT `response.status().json()`. Both
 *   services run on `@nestjs/platform-fastify`, where the Express idiom throws
 *   "response.status is not a function" (`nestjs-request-pipeline` rule 8).
 *
 * ⚠ `@Catch()` WITH NO ARGUMENT, AND THE ONLY FILTER. A catch-all must be registered
 *   BEFORE any specific one — NestJS reverses the list and the first match wins (rule
 *   7) — so the status mapping is a lookup inside it rather than a second filter with
 *   an order to get wrong.
 *
 * ⚠ NOTHING HERE REACHES A KAFKA CONSUMER, and that is not a gap: no filter runs for
 *   a KafkaJS handler. `@arthome-platform/messaging`'s `dispatch` and `routeFailure`
 *   own that path with their own retry and dead-letter policy, and still would for a
 *   service that both produces and consumes.
 */
@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorEnvelopeFilter.name);

  /**
   * @param uniqueViolationCodes - the service's uniquely-constrained columns and the
   *   published code each answers with. Empty is legitimate: `catalog`'s `show` has
   *   no unique constraint, so it can raise no conflict — and an unmapped violation is
   *   logged as a gap rather than given a generic code, because the contract's 409
   *   design is that the code names the specific refusal.
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
        // ⚠ OMITTED RATHER THAN EMPTY WHEN THERE IS NO TRACE. §5.5 makes `traceId` the
        //   link between "my application crashed" and a server log, and
        //   `ErrorSchema.traceId` is `z.string().min(1)`: an empty string would satisfy
        //   the field's presence and lead a reader to a log line that does not exist.
        //   `exactOptionalPropertyTypes` is why this is a spread.
        ...(trace === null ? {} : { traceId: trace.traceId }),
      },
      // critical-rules #9 and #6. Through the `Clock` port, never `new Date()` — a
      // filter that reads the machine's time cannot be asserted on (`kernel/clock.ts`).
      servedAt: this.clock.now(),
    };

    this.adapterHost.httpAdapter.reply(context.getResponse(), envelope, status);
  }

  /** The status and refusal to serve, in the order the cases must be tried. */
  private resolve(exception: unknown): { status: number; refusal: Refusal } {
    // First, because it is the only case that already knows its own code and
    // parameters. Everything below is reconstruction.
    if (exception instanceof RefusalException) {
      return { status: exception.getStatus(), refusal: exception.refusal };
    }

    // ⚠ SECOND, AND IT NEEDS NO TRANSLATION TABLE: `DomainError` already carries
    //   `code`, `params` and `nature`, the three fields §5.5 asks for. The domain
    //   throws these rather than `HttpException`s (rule 1) because a rule in
    //   `@arthome/core` is reachable from seven services and must not know what
    //   transport is above it.
    if (isDomainError(exception)) {
      return { status: statusForDomainError(exception), refusal: exception };
    }

    if (postgresErrorCodeOf(exception) === UNIQUE_VIOLATION) {
      return this.resolveUniqueViolation(constraintNameOf(exception));
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (exception.errorCode === undefined && !isMappedStatus(status)) {
        // A status nobody designed a code for. The response is honest rather than
        // invented, and the log is what gets the mapping written.
        this.logger.error(
          `No error code declared for status ${String(status)}; answered it anyway.`,
        );
      }
      const fallback = refusalForStatus(status);
      return {
        status,
        // `errorCode` if the thrower set one: the branchable id rule 2 asks for, and
        // honouring it is rule 8's purpose. `getResponse()` is NOT spread in — for a
        // built-in exception it holds an English `message`, which §5.5 forbids.
        refusal: { ...fallback, code: exception.errorCode ?? fallback.code },
      };
    }

    // ⚠ LOGGED HERE AND NOWHERE ELSE, AND THE RESPONSE SAYS NOTHING. An unknown error's
    //   message carries SQL, connection strings and stack frames, so it may not be
    //   echoed (rule 6). `Logger.error` takes the error so the stack survives.
    this.logger.error('Unhandled error; answered 500.', exception);
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      refusal: refusalForStatus(HttpStatus.INTERNAL_SERVER_ERROR),
    };
  }

  /**
   * ⚠ THE CONSTRAINT NAME IS READ, LOGGED, AND NEVER SERVED. It has to be read,
   *   because the contract's 409 design is that the code names the SPECIFIC refusal —
   *   `identity.email_taken` for one column and `identity.handle_taken` for the other —
   *   and collapsing both into one code is the false statement this exists to avoid.
   *
   *   What must not travel is the rest of the error. `QueryFailedError` copies the
   *   driver error's properties onto itself, so its `message` is pg's "duplicate key
   *   value violates unique constraint …" and its `detail` is
   *   "Key (email)=(someone@example.test) already exists" — the column AND the value.
   *   Only the code leaves; only the constraint name is logged, never the `detail`,
   *   which holds a person's address.
   *
   * ⚠ IT MATCHES THE COLUMN INSIDE THE CONSTRAINT NAME RATHER THAN THE WHOLE NAME.
   *   `account`'s two `UNIQUE`s are declared inline, so Postgres names them by its own
   *   `{table}_{column}_key` rule — `account_email_key` — and a later hand-named or
   *   ORM-generated `UQ_account_email` would break an exact match while meaning the
   *   same thing. The column is the fact; the constraint name is only its carrier.
   *   `public_handle` and `email` do not overlap, so there is no ambiguity. Not
   *   verified against a running Postgres — no container was available — so this is
   *   the first thing to check when the event-path walkthrough is next run.
   *
   *   `detail` would also name the column, and is NOT used for it: pg translates
   *   `detail` under `lc_messages` while constraint names are never translated.
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
 * ⚠ THE PER-CODE TABLE §5.5 CALLS FOR DOES NOT EXIST AND IS NOT INVENTED HERE. That
 *   document puts it "single, in `@arthome/contracts`"; there is none, and neither
 *   service depends on that package. Nature alone cannot choose — `refused` covers
 *   400, 401, 403, 404, 409 and 410 there — and 400 is the least wrong default for a
 *   refusal the caller's own input provoked. `publication.transition_forbidden`
 *   wanting 409 is what will force the real table.
 *
 *   `offline_forbidden` cannot arrive: §5.5 says the server never emits it. It falls
 *   to 503 with the rest rather than being special-cased into a lie.
 */
function statusForDomainError(error: DomainError): number {
  return error.nature === FailureNature.REFUSED
    ? HttpStatus.BAD_REQUEST
    : HttpStatus.SERVICE_UNAVAILABLE;
}

/**
 * ⚠ DUCK-TYPED RATHER THAN `instanceof QueryFailedError`, SO THE TRANSPORT LAYER DOES
 *   NOT DEPEND ON THE ORM. The next reader's instinct will be to import it; that would
 *   put `typeorm` in this library's manifest for one `instanceof`.
 *
 *   TypeORM 1.1.1 keeps the pg error on `driverError` and also copies its enumerable
 *   properties onto the wrapper, so both paths carry the code. `driverError` is read
 *   first because it is the authoritative one — the copy is an ORM convenience, and a
 *   version that stopped performing it would silently turn every conflict back into a
 *   500.
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
