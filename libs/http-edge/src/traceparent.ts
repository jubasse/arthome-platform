import { randomBytes } from 'node:crypto';

/**
 * No pipe can validate this: `@Headers` is `(property?: string) => ParameterDecorator` in
 *   `@nestjs/common` 12.0.3 — no options object, so no `schema` for
 *   `StandardSchemaValidationPipe` to find. A header is validated by hand or not at all.
 * Worth validating because of where it ends up: `outbox_event.tracecontext`, then a Kafka
 *   header, then every consumer of that topic. It is also the one outbox column with no CHECK
 *   constraint, so the guards on `aggregatetype`, `aggregateid`, `type` and `payload` have no
 *   counterpart here.
 * A malformed one must NOT fail the request — decided. Hence `null` rather than a throw: a
 *   broken trace is an observability fault, never a business one.
 */

/**
 * Version `00`: `00-<32 hex trace-id>-<16 hex parent-id>-<2 hex flags>`, 55 characters.
 *
 * The two lookaheads are what a length-and-alphabet check misses: the specification declares
 * an all-zero trace-id and parent-id INVALID, and both are what a half-initialised tracer
 * emits — they have the shape of a trace and link to nothing.
 *
 * Only `00` is accepted: it is the only version defined and `ff` is invalid by the
 *   specification. The day `01` exists, widen this rather than relax it — the trace-id is read
 *   here to serve as the error envelope's `traceId`.
 */
const TRACEPARENT_V00 = /^00-(?!0{32})([0-9a-f]{32})-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;

export interface TraceContext {
  /** The header verbatim — it is propagated, not rebuilt. */
  readonly traceparent: string;
  readonly traceId: string;
}

/**
 * A repeated header arrives joined by the adapter and is refused by the shape: two trace
 * contexts on one request name no single parent.
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
    // Unreachable while the capture group stands; `noUncheckedIndexedAccess` wants the branch
    // and §5.7 forbids the non-null assertion.
    return null;
  }
  return { traceparent: raw, traceId };
}

/** A root context, for the BFF when the surface sent none or a broken one (transport.md §5.2). */
export function newTraceparent(): string {
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
}
