// The wave-0 smoke test: it asserts the TOOLCHAIN, not this library — the three
// unpublished @arthome/* packages consumed as tarballs under vendor/, whose
// failures otherwise surface far away.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { StorefrontErrorSchema } from '@arthome/contracts/envelope';
import { API_ERROR_CODES } from '@arthome/core';

describe('the vendored @arthome/* chain', () => {
  it('resolves @arthome/core', () => {
    expect(API_ERROR_CODES.length).toBeGreaterThan(0);
  });

  it('resolves @arthome/contracts through a subpath', () => {
    // There is deliberately no `.` entry point: a subpath is the only import shape.
    expect(StorefrontErrorSchema).toBeDefined();
  });

  it('runs ONE copy of zod, not two', () => {
    // Two copies of zod in one node_modules make every schema fail every
    //   `instanceof` against the other copy, and the symptom is "this is not a
    //   zod schema" about something that plainly is.
    expect(StorefrontErrorSchema instanceof z.ZodType).toBe(true);
  });

  it('parses with the schemas it resolved', () => {
    const parsed = StorefrontErrorSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });
});
