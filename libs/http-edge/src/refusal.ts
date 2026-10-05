import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { z } from 'zod';

import {
  errorCodesOf,
  natureOf,
  statusOf,
  versionedPath,
  type CodedResponse,
  type CodesOf,
  type RouteShape,
} from '@arthome/contracts/http';
import {
  ApiErrorCode,
  DomainErrorCode,
  ERROR_CODES,
  FailureNature,
  SchemaIssueRule,
  type DomainError,
  type ErrorCode,
  type ErrorParamsOf,
} from '@arthome/core';
import { schemaInvalidParams } from '@arthome/core/schema';

/**
 * The one error shape this project has (transport.md §5.5, critical-rules #8): a code, its
 * parameters, the nature. Never a sentence — the surface composes the wording from `code`.
 *
 * `params` values are `unknown` because the two core types disagree: `MessageParams`
 *   refuses an array while `ErrorSchema.params` is `z.looseObject({})`, and the published
 *   contract shows `{ missing: ['poster', …] }`. This follows the wire schema.
 */
export interface Refusal {
  readonly code: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly nature: FailureNature;
}

/**
 * The message is the code: `errorCode` reaches the body only when the exception is built
 *   from a STRING message — with an object response the object is sent verbatim and the
 *   option is silently not merged.
 * The filter reads `.refusal`, not `getResponse()`: spreading the response would put
 *   NestJS's English `message` into a §5.5 envelope, the one thing it forbids.
 */
export class RefusalException extends HttpException {
  public readonly refusal: Refusal;

  public constructor(status: HttpStatus, refusal: Refusal, options?: { readonly cause: unknown }) {
    super(refusal.code, status, { errorCode: refusal.code, ...options });
    this.refusal = refusal;
  }
}

/** A code whose params are all optional: what a refusal known by a constraint's name can carry. */
export type ParamlessErrorCode = {
  [C in ErrorCode]: Record<never, never> extends ErrorParamsOf<C> ? C : never;
}[ErrorCode];

/**
 * A 409 carries the domain code naming the specific refusal, never a generic one — the
 *   published contract's 18 `409`s share one description reading "the `code` says which
 *   one". Hence a per-service table: the library knows how to match, the service knows what
 *   its columns mean.
 */
export interface UniqueViolationCode {
  /** The uniquely-constrained column, as it appears inside the constraint's name. */
  readonly column: string;
  /** The refusal, at its registry status: a 409 whose code names the conflict, from the name alone. */
  readonly code: ParamlessErrorCode;
}

/**
 * So a refusal NestJS or Fastify raised on its own — an unmatched route, an oversized payload, a
 * body that is not JSON — still leaves in §5.5's shape.
 *
 * 409 is absent on purpose: a conflict arrives either as a mapped unique violation or as a
 *   `ConflictException` whose thrower set `errorCode`. A bare one falling to the gap below is
 *   the correct outcome — it is a thrower who did not say which refusal it was.
 */
const REFUSAL_BY_STATUS = {
  [HttpStatus.BAD_REQUEST]: ApiErrorCode.SCHEMA_INVALID,
  [HttpStatus.UNAUTHORIZED]: ApiErrorCode.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: ApiErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ApiErrorCode.NOT_FOUND,
  [HttpStatus.PAYLOAD_TOO_LARGE]: ApiErrorCode.PAYLOAD_TOO_LARGE,
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: ApiErrorCode.UNSUPPORTED_MEDIA_TYPE,
  [HttpStatus.TOO_MANY_REQUESTS]: ApiErrorCode.RATE_LIMITED,
  [HttpStatus.INTERNAL_SERVER_ERROR]: ApiErrorCode.INTERNAL,
  [HttpStatus.SERVICE_UNAVAILABLE]: ApiErrorCode.SERVICE_UNAVAILABLE,
} satisfies Record<number, ErrorCode>;

/**
 * `api.upstream_unavailable` must not appear here: it means "a service behind the BFF
 *   failed", so on our own crash it is false and it destroys the one distinction a caller
 *   acts on — 503 is retryable, 500 is not. Measured while this was written: of the 28 code
 *   names transport.md's status table promises, 12 are emittable by nobody, and three of
 *   those were collapsing into one substitute here.
 */
export function refusalForStatus(status: number): Refusal {
  const code =
    (REFUSAL_BY_STATUS as Readonly<Record<number, ErrorCode>>)[status] ?? ApiErrorCode.INTERNAL;
  return { code, params: {}, nature: natureOf(code) };
}

export function isMappedStatus(status: number): boolean {
  return Object.hasOwn(REFUSAL_BY_STATUS, status);
}

/** A code of the published vocabulary, which the registry gives a status, rather than a domain guard's. */
export function isPublishedCode(code: string): code is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(code);
}

type ParamsArgument<C extends ErrorCode> =
  Record<never, never> extends ErrorParamsOf<C>
    ? [params?: ErrorParamsOf<C>]
    : [params: ErrorParamsOf<C>];

/** The refusal of `code`, at the status the error registry gives it, with the params it declares. */
export function refusalOf<C extends ErrorCode>(
  code: C,
  ...[params]: ParamsArgument<C>
): RefusalException {
  return new RefusalException(statusOf(code), {
    code,
    params: params ?? {},
    nature: natureOf(code),
  });
}

type CodesInResponse<Res> = CodesOf<Res> | (Res extends CodedResponse<infer C> ? C : never);

type CodesInResponses<R extends RouteShape> = {
  [S in keyof R['responses']]: CodesInResponse<R['responses'][S]>;
}[keyof R['responses']];

type CodesInErrorCodes<R> = R extends {
  readonly errorCodes?: Readonly<Record<string, readonly (infer C)[]>>;
}
  ? string extends C
    ? never
    : C
  : never;

/**
 * The codes a route declares, where its type carries them: its error responses' codes, and its
 *   `errorCodes` once typed. Each source is narrowed on its own: a wide `string` in one would
 *   swallow the others' literals.
 */
export type DeclaredCodeOf<R extends RouteShape> =
  Extract<CodesInResponses<R>, ErrorCode> | Extract<CodesInErrorCodes<R>, ErrorCode>;

const undeclaredLogger = new Logger('refuse');

/**
 * The refusal of `code` on `route`: only a code the route declares compiles, with the params the
 *   registry gives it. A code its `errorCodes` leaves out at that status still answers, and the log
 *   names it: the route's declaration is the one to fix.
 */
export function refuse<R extends RouteShape, C extends DeclaredCodeOf<R>>(
  route: R,
  code: C,
  ...[params]: ParamsArgument<C>
): RefusalException {
  const status = statusOf(code);
  const declared = errorCodesOf(route, status);
  if (declared !== undefined && !declared.includes(code)) {
    undeclaredLogger.error(
      `${route.method.toUpperCase()} ${versionedPath(route)} refused with ${code}, which it does ` +
        `not declare at ${String(status)}; answered it anyway.`,
    );
  }
  return new RefusalException(status, { code, params: params ?? {}, nature: natureOf(code) });
}

/** `refusalOf`, keeping what caused it for the log: a cause is never served. */
export function refusalCausedBy<C extends ErrorCode>(
  cause: unknown,
  code: C,
  ...[params]: ParamsArgument<C>
): RefusalException {
  return new RefusalException(
    statusOf(code),
    { code, params: params ?? {}, nature: natureOf(code) },
    { cause },
  );
}

/**
 * A domain error as the filter answers it: a published code at the status the error registry gives
 *   it, so no handler picks one. A domain guard's code is not published: a refusal the caller's own
 *   input provoked is the least wrong reading of it, 400, and an unavailable one 503.
 */
export function domainRefusal(error: DomainError): RefusalException {
  const status = isPublishedCode(error.code)
    ? statusOf(error.code)
    : error.nature === FailureNature.REFUSED
      ? HttpStatus.BAD_REQUEST
      : HttpStatus.SERVICE_UNAVAILABLE;
  return new RefusalException(status, error);
}

/** What a schema pipe hands over: a zod issue, under Standard Schema's name. */
interface StandardIssue {
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

function isZodIssue(issue: StandardIssue): issue is z.core.$ZodIssue {
  return 'code' in issue && Array.isArray(issue.path);
}

/**
 * `api.schema_invalid` with each issue's path, rule and limit, never the library's English message.
 *   An issue that is not zod's, which no schema here produces, reads as a broken custom rule.
 */
export function schemaInvalidException(issues: readonly StandardIssue[]): RefusalException {
  const zodIssues = issues.map((issue): z.core.$ZodIssue =>
    isZodIssue(issue)
      ? issue
      : {
          code: SchemaIssueRule.CUSTOM,
          path: (issue.path ?? []).map((segment) =>
            typeof segment === 'object' ? segment.key : segment,
          ),
          message: '',
          input: undefined,
        },
  );
  return refusalOf(ApiErrorCode.SCHEMA_INVALID, schemaInvalidParams(zodIssues));
}

/** `api.not_found` is a route that does not resolve, which a route naming nothing held here is too. */
export function notFound(): RefusalException {
  return refusalOf(ApiErrorCode.NOT_FOUND);
}

/** A command sent against a version that has moved, naming the version the caller must read again. */
export function stateConflict(currentVersion: number): RefusalException {
  return refusalOf(DomainErrorCode.STATE_CONFLICT, { currentVersion });
}
