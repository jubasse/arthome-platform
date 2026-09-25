import { describe, expect, it } from 'vitest';

import { parseTraceparent } from './traceparent.js';

/** The traceparent `AGENTS.md`'s walkthrough sends, and the one the outbox test asserts. */
const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('the inbound traceparent', () => {
  it('keeps a well-formed header verbatim and exposes its trace-id', () => {
    // Verbatim matters: the value is PROPAGATED, not rebuilt. A reassembled
    // header that differs by one character joins a different trace.
    expect(parseTraceparent(VALID)).toEqual({
      traceparent: VALID,
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    });
  });

  it('carries nothing when the header is absent', () => {
    expect(parseTraceparent(undefined)).toBeNull();
  });

  it('drops a malformed header instead of failing the request', () => {
    // ⚠ THE DECISION THIS FUNCTION EXISTS TO KEEP. A broken trace is an
    //   observability fault, never a business one, so every one of these becomes
    //   `null` and the registration proceeds. Throwing here would refuse a
    //   registration over a header, which is settled and not reopened.
    for (const raw of [
      '',
      'not-a-traceparent',
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7', // no flags
      '00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01', // trace-id 31 chars
      '00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01', // upper case
      `${VALID} `, // trailing space
      `${VALID}-extra`,
    ]) {
      expect(parseTraceparent(raw)).toBeNull();
    }
  });

  it('refuses an all-zero trace-id, which a broken instrumentation emits and which joins nothing', () => {
    // Invalid by the specification, and exactly what a half-initialised tracer
    // sends: it has the shape of a trace and links to no span. Stored in three
    // databases it would look like a real context for ever.
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();
    // A trace-id of 31 zeros and a 1 is legal, and must not be caught with it.
    expect(
      parseTraceparent('00-00000000000000000000000000000001-00f067aa0ba902b7-01'),
    ).not.toBeNull();
  });

  it('refuses an all-zero parent-id', () => {
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01')).toBeNull();
  });

  it('refuses a version it cannot parse, rather than storing bytes it cannot read', () => {
    // `ff` is invalid by the specification; `01` does not exist yet. Only `00` is
    // defined, so the cost of this strictness is currently nil — and the reason it
    // is strictness rather than pass-through is that the trace-id is READ here, to
    // serve as the error envelope's `traceId`.
    expect(parseTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull();
  });

  it('refuses two headers joined into one, because two contexts name no single parent', () => {
    expect(parseTraceparent(`${VALID}, ${VALID}`)).toBeNull();
  });
});
