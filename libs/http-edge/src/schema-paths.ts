import type { z } from 'zod';

import { sensitivePathsOf, type Route } from '@arthome/contracts/http';

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

const sensitivePathsBySource = new WeakMap<object, readonly string[]>();

function schemasOf(route: Route): z.ZodType[] {
  const bodies = [
    route.requestBody?.content['application/json']?.schema,
    ...Object.values(route.responses).map(
      (response) => response.content?.['application/json']?.schema,
    ),
  ];
  return bodies.filter((schema): schema is z.ZodType => schema !== undefined);
}

function isSchema(source: Route | z.ZodType): source is z.ZodType {
  return '_zod' in source;
}

function sensitivePathsFrom(source: Route | z.ZodType): readonly string[] {
  const known = sensitivePathsBySource.get(source);
  if (known !== undefined) return known;
  const schemas = isSchema(source) ? [source] : schemasOf(source);
  const paths = [...new Set(schemas.flatMap((schema) => sensitivePathsOf(schema)))];
  sensitivePathsBySource.set(source, paths);
  return paths;
}

/**
 * A copy of a body fit for a log line or a trace attribute: every field marked `sensitive` (a
 *   password, a token, a stream key) replaced by `[redacted]` (ADR contract model §9.7). Given a
 *   route, the marks of its request body and of every response it declares.
 */
export function redactSensitive(source: Route | z.ZodType, value: unknown): unknown {
  return sensitivePathsFrom(source).reduce<unknown>(
    (redacted, path) => edited(redacted, segmentsOf(path), () => REDACTED),
    value,
  );
}
