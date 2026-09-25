import { HttpException, HttpStatus } from '@nestjs/common';

import { ApiErrorCode, FailureNature } from '@arthome/core';

/**
 * The one error shape this project has (transport.md §5.5, critical-rules #8): a code, its
 * parameters, the nature. Never a sentence — the surface composes the wording from `code`.
 *
 * ⚠ `params` values are `unknown` because the two core types disagree: `MessageParams`
 *   refuses an array while `ErrorSchema.params` is `z.looseObject({})`, and the published
 *   contract shows `{ missing: ['poster', …] }`. This follows the wire schema.
 */
export interface Refusal {
  readonly code: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly nature: FailureNature;
}

/**
 * ⚠ The message is the code: `errorCode` reaches the body only when the exception is built
 *   from a STRING message — with an object response the object is sent verbatim and the
 *   option is silently not merged.
 * ⚠ The filter reads `.refusal`, not `getResponse()`: spreading the response would put
 *   NestJS's English `message` into a §5.5 envelope, the one thing it forbids.
 */
export class RefusalException extends HttpException {
  public readonly refusal: Refusal;

  public constructor(status: HttpStatus, refusal: Refusal, options?: { readonly cause: unknown }) {
    super(refusal.code, status, { errorCode: refusal.code, ...options });
    this.refusal = refusal;
  }
}

/**
 * ⚠ A 409 carries the domain code naming the specific refusal, never a generic one — the
 *   published contract's 18 `409`s share one description reading "the `code` says which
 *   one". Hence a per-service table: the library knows how to match, the service knows what
 *   its columns mean.
 */
export interface UniqueViolationCode {
  /** The uniquely-constrained column, as it appears inside the constraint's name. */
  readonly column: string;
  /** A published `ERROR_CODES` member naming this refusal. Never invented locally. */
  readonly code: string;
}

/**
 * So a refusal NestJS raised on its own — an unmatched route, an oversized payload — still
 * leaves in §5.5's shape.
 *
 * ⚠ 409 is absent on purpose: a conflict arrives either as a mapped unique violation or as a
 *   `ConflictException` whose thrower set `errorCode`. A bare one falling to the gap below is
 *   the correct outcome — it is a thrower who did not say which refusal it was.
 */
const REFUSAL_BY_STATUS = {
  [HttpStatus.BAD_REQUEST]: { code: ApiErrorCode.SCHEMA_INVALID, nature: FailureNature.REFUSED },
  [HttpStatus.UNAUTHORIZED]: { code: ApiErrorCode.UNAUTHENTICATED, nature: FailureNature.REFUSED },
  [HttpStatus.FORBIDDEN]: { code: ApiErrorCode.FORBIDDEN, nature: FailureNature.REFUSED },
  [HttpStatus.NOT_FOUND]: { code: ApiErrorCode.NOT_FOUND, nature: FailureNature.REFUSED },
  [HttpStatus.TOO_MANY_REQUESTS]: {
    code: ApiErrorCode.RATE_LIMITED,
    nature: FailureNature.UNAVAILABLE,
  },
  [HttpStatus.INTERNAL_SERVER_ERROR]: {
    code: ApiErrorCode.INTERNAL,
    nature: FailureNature.UNAVAILABLE,
  },
  [HttpStatus.SERVICE_UNAVAILABLE]: {
    code: ApiErrorCode.SERVICE_UNAVAILABLE,
    nature: FailureNature.UNAVAILABLE,
  },
} satisfies Record<number, { code: string; nature: FailureNature }>;

/**
 * ⚠ `api.upstream_unavailable` must not appear here: it means "a service behind the BFF
 *   failed", so on our own crash it is false and it destroys the one distinction a caller
 *   acts on — 503 is retryable, 500 is not. Measured while this was written: of the 28 code
 *   names transport.md's status table promises, 12 are emittable by nobody, and three of
 *   those were collapsing into one substitute here.
 */
export function refusalForStatus(status: number): Refusal {
  const known = (REFUSAL_BY_STATUS as Record<number, { code: string; nature: FailureNature }>)[
    status
  ];
  return known === undefined
    ? { code: ApiErrorCode.INTERNAL, params: {}, nature: FailureNature.UNAVAILABLE }
    : { code: known.code, params: {}, nature: known.nature };
}

export function isMappedStatus(status: number): boolean {
  return Object.hasOwn(REFUSAL_BY_STATUS, status);
}

/**
 * ⚠ `message` is deliberately untyped: an issue carries a library's English prose, and not
 *   typing it is how this file cannot forward it to a wire by accident.
 * ⚠ Declared, not imported: `StandardSchemaV1.Issue` lives in `@standard-schema/spec`,
 *   `@nestjs/common`'s dependency and not this library's. This shape is structurally what the
 *   pipe passes, so `exceptionFactory` still type-checks.
 */
interface SchemaIssue {
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

function dottedFieldPath(issue: SchemaIssue): string {
  return (issue.path ?? [])
    .map((segment) =>
      typeof segment === 'object' && segment !== null ? String(segment.key) : String(segment),
    )
    .join('.');
}

/**
 * ⚠ `issueToCode` is not used: it builds `validation.<code>`, a spelling in no `ERROR_CODES`
 *   family, and it reads a ZOD issue where `exceptionFactory` gets Standard Schema's, which
 *   has no `code`. §5.5 fixes the code anyway, so an issue is read for its path alone.
 * ⚠ `fields` is plural, which `issueToCode` could not give — the envelope has one `params` and
 *   a form needs every failing field. Sorted and de-duplicated so equal bodies answer alike.
 */
export function schemaInvalidRefusal(issues: readonly SchemaIssue[]): Refusal {
  const fields = [...new Set(issues.map(dottedFieldPath).filter((path) => path.length > 0))].sort();
  return {
    code: ApiErrorCode.SCHEMA_INVALID,
    // Omitted rather than empty: `fields: []` reads as "no field was at fault", the opposite
    // of what a root-level failure — a body that is not an object — means.
    params: fields.length > 0 ? { fields } : {},
    nature: FailureNature.REFUSED,
  };
}

export function schemaInvalidException(issues: readonly SchemaIssue[]): RefusalException {
  return new RefusalException(HttpStatus.BAD_REQUEST, schemaInvalidRefusal(issues));
}
