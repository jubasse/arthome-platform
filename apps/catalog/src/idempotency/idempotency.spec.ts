import { RefusalException } from '@arthome-platform/http-edge';
import { describe, expect, it } from 'vitest';

import { fingerprintOf, idempotencyKeyOf } from './idempotency.js';

describe('idempotencyKeyOf', () => {
  it('accepts a UUID', () => {
    expect(idempotencyKeyOf('019928f4-1b6c-7c3a-9f2e-6a1d0c4b8e77')).toBe(
      '019928f4-1b6c-7c3a-9f2e-6a1d0c4b8e77',
    );
  });

  it.each([undefined, '', 'not-a-uuid'])(
    'refuses %j as a schema fault naming the header',
    (key) => {
      try {
        idempotencyKeyOf(key);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(RefusalException);
        expect((error as RefusalException).refusal.params).toEqual({ fields: ['Idempotency-Key'] });
      }
    },
  );
});

describe('fingerprintOf', () => {
  it('is equal for the same method, path and body', () => {
    expect(fingerprintOf('POST', '/dates', { a: 1 })).toBe(
      fingerprintOf('POST', '/dates', { a: 1 }),
    );
  });

  it('tells two paths apart under one body, so one key cannot answer another resource', () => {
    expect(fingerprintOf('POST', '/dates/1/publication/transitions', { to: 'reserve' })).not.toBe(
      fingerprintOf('POST', '/dates/2/publication/transitions', { to: 'reserve' }),
    );
  });
});
