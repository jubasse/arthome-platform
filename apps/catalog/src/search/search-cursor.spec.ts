import { RefusalException } from '@arthome-platform/http-edge';
import { describe, expect, it } from 'vitest';

import { ApiErrorCode } from '@arthome/core';

import { MAX_RESULT_WINDOW, cursorAt, offsetOf } from './search-cursor.js';

const NOW = Date.parse('2026-09-26T20:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function refusalOf(cursor: string, nowMs = NOW): RefusalException {
  try {
    offsetOf(cursor, nowMs);
  } catch (error) {
    if (error instanceof RefusalException) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('the search cursor', () => {
  it('starts at the first result without one, and returns the offset it carries', () => {
    expect(offsetOf(undefined, NOW)).toBe(0);
    expect(offsetOf(cursorAt(40, NOW), NOW + 1_000)).toBe(40);
  });

  it('expires after 24 hours with a 410', () => {
    expect(offsetOf(cursorAt(20, NOW), NOW + DAY_MS)).toBe(20);

    const refusal = refusalOf(cursorAt(20, NOW), NOW + DAY_MS + 1);
    expect(refusal.getStatus()).toBe(410);
    expect(refusal.refusal.code).toBe(ApiErrorCode.CURSOR_TOO_OLD);
  });

  it('refuses a cursor it did not write, or one past the window the index can page', () => {
    for (const cursor of ['bm90LWpzb24', cursorAt(-1, NOW), cursorAt(MAX_RESULT_WINDOW, NOW)]) {
      expect(refusalOf(cursor).refusal).toMatchObject({
        code: ApiErrorCode.SCHEMA_INVALID,
        params: { fields: ['cursor'] },
      });
    }
  });
});
