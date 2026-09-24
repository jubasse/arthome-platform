// The wave-0 smoke test: it asserts the TOOLCHAIN, not this library.
//
// arthome-platform consumes three unpublished packages as tarballs under
// vendor/. Plenty can go wrong in that chain and stay invisible until something
// far away behaves oddly, so the chain is asserted here, once, where a failure
// names itself.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { StorefrontErrorSchema } from '@arthome/contracts/envelope';
import { API_ERROR_CODES } from '@arthome/core';

describe('the vendored @arthome/* chain', () => {
  it('resolves @arthome/core', () => {
    expect(API_ERROR_CODES.length).toBeGreaterThan(0);
  });

  it('resolves @arthome/contracts through a subpath', () => {
    // There is deliberately no `.` entry point: the barrel rule is structural
    // rather than a convention, so this import shape is the only one there is.
    expect(StorefrontErrorSchema).toBeDefined();
  });

  it('runs ONE copy of zod, not two', () => {
    // ⚠ THE FAULT THIS GUARDS AGAINST DOES NOT LOOK LIKE A VERSION PROBLEM.
    //   `instanceof` compares class identity, so two copies of zod in one
    //   node_modules make every schema fail every instanceof against the other
    //   copy — and the symptom is "this is not a zod schema" about something
    //   that plainly is. arthome-core's emit tool had to resolve zod from
    //   packages/contracts for exactly this reason, and a tarball install is a
    //   new chance to end up with two.
    expect(StorefrontErrorSchema instanceof z.ZodType).toBe(true);
  });

  it('parses with the schemas it resolved', () => {
    const parsed = StorefrontErrorSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });
});
