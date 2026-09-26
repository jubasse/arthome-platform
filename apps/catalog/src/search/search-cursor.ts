import { RefusalException, schemaInvalidRefusal } from '@arthome-platform/http-edge';
import { HttpStatus } from '@nestjs/common';

import { ApiErrorCode, FailureNature } from '@arthome/core';

/** The `Cursor` parameter's promise in `storefront.yaml`. */
const CURSOR_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * OpenSearch's default `index.max_result_window`: `from + size` past it is an error, not an
 *   empty page. The date index does not raise it.
 */
export const MAX_RESULT_WINDOW = 10_000;

/**
 * AN OFFSET, NOT D-010'S `(created_at, id)`, because grouping by show needs `collapse`, and
 *   OpenSearch 2.18 refuses `collapse` with `search_after` whatever the sort (measured on the
 *   local cluster, 2026-09-26). A page can therefore shift when the index changes between two
 *   calls, which a search tolerates and a feed would not.
 */
interface OffsetCursor {
  readonly offset: number;
  readonly issuedAtMs: number;
}

export function cursorAt(offset: number, issuedAtMs: number): string {
  return Buffer.from(JSON.stringify({ offset, issuedAtMs } satisfies OffsetCursor)).toString(
    'base64url',
  );
}

function malformedCursor(): RefusalException {
  return new RefusalException(HttpStatus.BAD_REQUEST, schemaInvalidRefusal([{ path: ['cursor'] }]));
}

function decoded(cursor: string): OffsetCursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof value === 'object' &&
      value !== null &&
      'offset' in value &&
      'issuedAtMs' in value &&
      Number.isSafeInteger(value.offset) &&
      Number.isSafeInteger(value.issuedAtMs)
    ) {
      return value as OffsetCursor;
    }
  } catch {
    // Falls through to the refusal: a cursor is opaque, so a broken one is the caller's.
  }
  throw malformedCursor();
}

/** The first result a cursor points at, 0 without one. */
export function offsetOf(cursor: string | undefined, nowMs: number): number {
  if (cursor === undefined) return 0;
  const { offset, issuedAtMs } = decoded(cursor);
  if (offset < 0 || offset >= MAX_RESULT_WINDOW) throw malformedCursor();
  if (nowMs - issuedAtMs > CURSOR_LIFETIME_MS) {
    throw new RefusalException(HttpStatus.GONE, {
      code: ApiErrorCode.CURSOR_TOO_OLD,
      params: {},
      nature: FailureNature.REFUSED,
    });
  }
  return offset;
}
