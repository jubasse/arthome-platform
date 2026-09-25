/**
 * ⚠ NO PIPE CAN VALIDATE THIS. `@Headers` is `(property?: string) =>
 *   ParameterDecorator` in the installed `@nestjs/common` 12.0.3 — no options object,
 *   so no `schema` for `StandardSchemaValidationPipe` to find
 *   (`nestjs-validation` rule 3). A header is validated by hand or not at all.
 *
 * ⚠ AND IT IS WORTH VALIDATING BECAUSE OF WHERE IT ENDS UP: `outbox_event.tracecontext`,
 *   then a Kafka header, then every consumer of that topic. It is also the ONE outbox
 *   column with no CHECK constraint, so the guards `@arthome-platform/messaging` puts
 *   on `aggregatetype`, `aggregateid`, `type` and `payload` have no counterpart here.
 *
 * ⚠ A MALFORMED ONE MUST NOT FAIL THE REQUEST — decided, at
 *   `identity.controller.ts:23-26`. Hence `null` rather than a throw: a broken trace
 *   is an observability fault, never a business one, and refusing a write over one
 *   would reopen a settled decision.
 */

/**
 * Version `00`: `00-<32 hex trace-id>-<16 hex parent-id>-<2 hex flags>`, 55
 * characters, lowercase.
 *
 * The two lookaheads are what a length-and-alphabet check misses: the specification
 * declares an all-zero trace-id and parent-id INVALID, and both are what a
 * half-initialised tracer emits — they have the shape of a trace and link to nothing.
 *
 * ⚠ ONLY `00` IS ACCEPTED, at currently nil cost: it is the only version defined, and
 *   `ff` is invalid by the specification. The day `01` exists this regex is the place
 *   to widen — and widen rather than relax, because the trace-id is READ here to serve
 *   as the error envelope's `traceId` (`transport.md` §5.5).
 */
const TRACEPARENT_V00 = /^00-(?!0{32})([0-9a-f]{32})-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;

export interface TraceContext {
  /** The header verbatim — it is propagated, not rebuilt. */
  readonly traceparent: string;
  readonly traceId: string;
}

/**
 * A repeated header arrives joined by the adapter and is refused by the shape: two
 * trace contexts on one request name no single parent.
 */
export function parseTraceparent(raw: string | undefined): TraceContext | null {
  if (raw === undefined) {
    return null;
  }
  const match = TRACEPARENT_V00.exec(raw);
  if (match === null) {
    return null;
  }
  const traceId = match[1];
  if (traceId === undefined) {
    // Unreachable while the capture group stands. `noUncheckedIndexedAccess` wants the
    // branch, and §5.7 forbids the non-null assertion outright.
    return null;
  }
  return { traceparent: raw, traceId };
}
