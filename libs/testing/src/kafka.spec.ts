import type { EachMessagePayload } from 'kafkajs';
import { describe, expect, it } from 'vitest';

import { headersOf } from './kafka.js';

/**
 * The only part of this package that can be asserted without a container, so it
 * is the only part named `.spec.ts` — `pnpm run verify` runs this file and must
 * never run the `.itest.ts` ones beside it.
 */
function payload(headers: Record<string, string>): EachMessagePayload {
  return {
    topic: 'arthome.harness.probe',
    partition: 0,
    message: {
      key: Buffer.from('key'),
      value: Buffer.from('value'),
      headers: Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name, Buffer.from(value)]),
      ),
    },
  } as unknown as EachMessagePayload;
}

describe('headersOf', () => {
  it('turns every header into a string', () => {
    const named = headersOf(payload({ 'message-id': 'abc', type: 'harness.probe.happened.v1' }));
    expect(named).toEqual({ 'message-id': 'abc', type: 'harness.probe.happened.v1' });
  });

  it('treats Debezium’s literal "null" as an ABSENT header, not as a value', () => {
    // Debezium renders a NULL column as the four characters `null` rather than
    // as a missing header. A helper that handed that through would let a test
    // assert on a traceparent whose value is the word "null" — and pass.
    const named = headersOf(payload({ 'message-id': 'abc', traceparent: 'null' }));

    expect(named).not.toHaveProperty('traceparent');
    expect(named['message-id']).toBe('abc');
  });

  it('answers with nothing when a message carries no headers at all', () => {
    expect(headersOf(payload({}))).toEqual({});
  });
});
