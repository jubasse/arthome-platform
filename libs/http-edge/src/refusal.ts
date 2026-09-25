import { HttpException, HttpStatus } from '@nestjs/common';

import { ApiErrorCode, FailureNature } from '@arthome/core';

/**
 * A refusal in the one error shape this project has — `transport.md` §5.5 and
 * critical-rules #8: a code, its parameters, the nature. Never a sentence; the
 * surface composes the wording from `code`, in the reader's language.
 *
 * ⚠ `params` VALUES ARE `unknown` BECAUSE THE TWO CORE TYPES DISAGREE.
 *   `MessageParams` is `Record<string, string | number | boolean>` and refuses an
 *   array; `ErrorSchema.params` is `z.looseObject({})`, and `schema/error.ts` says
 *   why — the studio contract publishes `{ missing: ['poster', …] }` as an example
 *   of this field. This follows the wire schema, which matches the published
 *   contract.
 */
export interface Refusal {
  readonly code: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly nature: FailureNature;
}

/**
 * An `HttpException` carrying a `Refusal` instead of a message.
 *
 * ⚠ THE MESSAGE IS THE CODE, LOAD-BEARING TWICE. `errorCode` reaches the body only
 *   when the exception is built from a STRING message — with an object response the
 *   object is sent verbatim and the option is silently not merged
 *   (`nestjs-request-pipeline` rule 2; needs `@nestjs/common` >= 12.0.2, this
 *   repository is on 12.0.3). And critical-rules #8 wants a code where a sentence
 *   would go, so both requirements want the same thing.
 *
 * ⚠ THE FILTER READS `.refusal`, NOT `getResponse()`. Rule 8's purpose — do not drop
 *   `errorCode` while adding envelope fields — is met by carrying the refusal;
 *   spreading the response would put NestJS's English `message` into a §5.5
 *   envelope, the one thing that envelope forbids.
 */
export class RefusalException extends HttpException {
  public readonly refusal: Refusal;

  public constructor(status: HttpStatus, refusal: Refusal, options?: { readonly cause: unknown }) {
    super(refusal.code, status, { errorCode: refusal.code, ...options });
    this.refusal = refusal;
  }
}

/**
 * Which code a unique violation answers with, per uniquely-constrained column.
 *
 * ⚠ A 409 CARRIES THE DOMAIN CODE THAT NAMES THE SPECIFIC REFUSAL, never a generic
 *   one. That is the published contract's design: its 18 `409` responses share one
 *   `Conflict` description reading "Definitive business refusal. The `code` says
 *   which one". So this is a per-service table rather than a constant in here —
 *   the library knows how to match, and the service knows what its columns mean.
 *
 * ⚠ AND `identity.*` STAYING VAGUE DOES NOT APPLY. That standing exception is about
 *   an AUTHENTICATION refusal, and `identity.email_taken`'s own publication proves
 *   the scope: were the exception to cover sign-up, the member would contradict the
 *   rule declared beside it.
 */
export interface UniqueViolationCode {
  /** The uniquely-constrained column, as it appears inside the constraint's name. */
  readonly column: string;
  /** A published `ERROR_CODES` member naming this refusal. Never invented locally. */
  readonly code: string;
}

/**
 * The code and nature per status, so a refusal NestJS raised on its own — an
 * unmatched route, an oversized payload — still leaves in §5.5's shape. A lookup
 * rather than a `switch` so the covered statuses are countable by reading it.
 *
 * ⚠ 409 IS ABSENT ON PURPOSE. There is no generic conflict member and there should
 *   not be one; a conflict arrives here either as a mapped unique violation or as a
 *   `ConflictException` whose thrower set `errorCode`. A bare `ConflictException`
 *   falls to the gap below, and that is the correct outcome: it is a thrower who
 *   did not say which refusal it was.
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
 * ⚠ `api.upstream_unavailable` APPEARS NOWHERE IN THIS FILE AND MUST NOT. It means
 *   "a service behind the BFF failed"; on our own crash it is false, and it destroys
 *   the one distinction a caller acts on — 503 is retryable, 500 is not. It stays
 *   reserved for the BFF relaying a failed service. Measured while this was written:
 *   `transport.md`'s status table promises 28 code names and 12 are emittable by
 *   nobody, and three of those were collapsing into one substitute here.
 */
export function refusalForStatus(status: number): Refusal {
  const known = (REFUSAL_BY_STATUS as Record<number, { code: string; nature: FailureNature }>)[
    status
  ];
  return known === undefined
    ? { code: ApiErrorCode.INTERNAL, params: {}, nature: FailureNature.UNAVAILABLE }
    : { code: known.code, params: {}, nature: known.nature };
}

/** True when this status has a designed code, so the filter can log the gap when it does not. */
export function isMappedStatus(status: number): boolean {
  return Object.hasOwn(REFUSAL_BY_STATUS, status);
}

/**
 * One Standard Schema issue, narrowed to the only part that may leave this process.
 *
 * ⚠ `message` IS DELIBERATELY UNTYPED HERE. An issue carries one and it is a
 *   library's English prose; `@arthome/core/schema`'s `issueToCode` says putting one
 *   on a wire makes the contract's language the library's. Not typing it is how this
 *   file cannot forward it by accident.
 *
 * ⚠ DECLARED, NOT IMPORTED: `StandardSchemaV1.Issue` lives in
 *   `@standard-schema/spec`, `@nestjs/common`'s dependency and not this library's.
 *   This shape is structurally what the pipe passes, so `exceptionFactory` still
 *   type-checks.
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
 * ⚠ `issueToCode` IS NOT USED, AND NOT BECAUSE IT WAS OVERLOOKED. It takes a ZOD
 *   issue and reads `issue.code` to build `validation.<code>` — a spelling that is in
 *   no `ERROR_CODES` family, so no surface could translate it, which is the same
 *   objection that settled the 409. `exceptionFactory` is also typed against
 *   STANDARD SCHEMA's issue, which has no `code` at all. §5.5 fixes the code anyway:
 *   "A zod validation failure becomes `SCHEMA_INVALID` with the field paths in
 *   `params` — never zod's English message." So an issue is read for its path alone,
 *   which is `issueToCode`'s other half and the half that was portable.
 *
 * ⚠ `fields` IS PLURAL, WHICH `issueToCode` COULD NOT GIVE — it is per-issue and
 *   returns `{ field }`, while the envelope has one `params` per response and a form
 *   needs every failing field. Sorted and de-duplicated so two identical bad bodies
 *   answer identically.
 */
export function schemaInvalidRefusal(issues: readonly SchemaIssue[]): Refusal {
  const fields = [...new Set(issues.map(dottedFieldPath).filter((path) => path.length > 0))].sort();
  return {
    code: ApiErrorCode.SCHEMA_INVALID,
    // Omitted rather than empty: `fields: []` reads as "no field was at fault", the
    // opposite of what a root-level failure — a body that is not an object — means.
    params: fields.length > 0 ? { fields } : {},
    nature: FailureNature.REFUSED,
  };
}

export function schemaInvalidException(issues: readonly SchemaIssue[]): RefusalException {
  return new RefusalException(HttpStatus.BAD_REQUEST, schemaInvalidRefusal(issues));
}
