import type { z } from 'zod';

import { sensitivePathsOf } from '@arthome/contracts/http';

const REMOVED: unique symbol = Symbol('field to remove');

/** `data.items[].revenue` as `['data', 'items', '[]', 'revenue']`; `*` is each value of a record. */
function segmentsOf(path: string): string[] {
  return path
    .split('.')
    .flatMap((part) => (part.endsWith('[]') ? [part.slice(0, -2), '[]'] : [part]))
    .filter((segment) => segment !== '');
}

function edited(
  value: unknown,
  segments: readonly string[],
  replace: (field: unknown) => unknown,
): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) return replace(value);
  if (head === '[]') {
    return Array.isArray(value)
      ? value.map((item) => edited(item, rest, replace)).filter((item) => item !== REMOVED)
      : value;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>).flatMap(([key, field]) => {
      if (head !== '*' && head !== key) return [[key, field]];
      const result = edited(field, rest, replace);
      return result === REMOVED ? [] : [[key, result]];
    }),
  );
}

/** A copy without the field at a path `restrictedFieldsOf` or `sensitivePathsOf` gives. */
export function withoutPath(value: unknown, path: string): unknown {
  return edited(value, segmentsOf(path), () => REMOVED);
}

export const REDACTED = '[redacted]';

const sensitivePathsBySchema = new WeakMap<z.ZodType, readonly string[]>();

/**
 * A copy of a body fit for a log line: every field the schema marks `sensitive` (a password, a
 *   token, a stream key) replaced by `[redacted]` (ADR contract model §9.7).
 */
export function redactSensitive(schema: z.ZodType, value: unknown): unknown {
  let paths = sensitivePathsBySchema.get(schema);
  if (paths === undefined) {
    paths = sensitivePathsOf(schema);
    sensitivePathsBySchema.set(schema, paths);
  }
  return paths.reduce<unknown>(
    (redacted, path) => edited(redacted, segmentsOf(path), () => REDACTED),
    value,
  );
}
