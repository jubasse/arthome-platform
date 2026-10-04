import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import type { z } from 'zod';

import {
  cacheControlOf,
  restrictedFieldsOf,
  sensitivePathsOf,
  type RestrictedField,
  type Route,
} from '@arthome/contracts/http';

import {
  ENDPOINT_GUARDS,
  routeOf,
  routePrincipalOf,
  type EndpointGuards,
} from './endpoint-access.js';

/** The right every identified caller holds, so an `optionalAuth` route can restrict a field to it (ADR §6.3). */
export const SIGNED_IN_RIGHT = 'signedIn';

interface HeaderWriter {
  header(name: string, value: string): unknown;
}

interface SuccessMarks {
  readonly restricted: readonly RestrictedField[];
  readonly sensitive: boolean;
}

const marksByRoute = new WeakMap<Route, SuccessMarks>();

function successSchemasOf(route: Route): z.ZodType[] {
  return Object.entries(route.responses)
    .filter(([status]) => status.startsWith('2'))
    .flatMap(([, response]) => {
      const schema = response.content?.['application/json']?.schema;
      return schema === undefined ? [] : [schema];
    });
}

function marksOf(route: Route): SuccessMarks {
  const known = marksByRoute.get(route);
  if (known !== undefined) return known;
  const schemas = successSchemasOf(route);
  const marks = {
    restricted: schemas.flatMap((schema) => restrictedFieldsOf(schema)),
    sensitive: schemas.some((schema) => sensitivePathsOf(schema).length > 0),
  };
  marksByRoute.set(route, marks);
  return marks;
}

function rightsOf(principal: unknown): ReadonlySet<string> {
  if (principal === null || principal === undefined) return new Set();
  const rights = (principal as { readonly rights?: unknown }).rights;
  const held = Array.isArray(rights)
    ? rights.filter((right): right is string => typeof right === 'string')
    : [];
  return new Set([SIGNED_IN_RIGHT, ...held]);
}

/** `data.items[].revenue` as `['data', 'items', '[]', 'revenue']`; `*` is each value of a record. */
function segmentsOf(path: string): string[] {
  return path
    .split('.')
    .flatMap((part) => (part.endsWith('[]') ? [part.slice(0, -2), '[]'] : [part]))
    .filter((segment) => segment !== '');
}

function without(value: unknown, segments: readonly string[]): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  if (head === '[]') return Array.isArray(value) ? value.map((item) => without(item, rest)) : value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Readonly<Record<string, unknown>>;
  if (head === '*') {
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, without(item, rest)]),
    );
  }
  if (!Object.hasOwn(record, head)) return value;
  if (rest.length === 0) {
    const { [head]: _removed, ...kept } = record;
    return kept;
  }
  return { ...record, [head]: without(record[head], rest) };
}

/**
 * After the handler and the success envelope, so its paths are the declared body's: removes each
 *   restricted field the caller lacks the right for, absent rather than null (critical rule 11),
 *   and writes the headers the declaration implies: the freshness, `no-store` on an answer holding
 *   a sensitive field, and the identity's own (the rights version).
 */
@Injectable()
export class EndpointResponseInterceptor implements NestInterceptor {
  public constructor(
    private readonly reflector: Reflector,
    @Inject(ENDPOINT_GUARDS) private readonly guards: EndpointGuards,
  ) {}

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const route = routeOf(this.reflector, context);
    if (route === undefined) return next.handle();

    return next.handle().pipe(
      map((body: unknown) => {
        const http = context.switchToHttp();
        const principal =
          route.access === undefined ? undefined : routePrincipalOf(http.getRequest<object>());
        this.writeHeaders(route, principal, http.getResponse<HeaderWriter>());
        const rights = rightsOf(principal);
        return marksOf(route)
          .restricted.filter(({ right }) => !rights.has(right))
          .reduce((projected, { path }) => without(projected, segmentsOf(path)), body);
      }),
    );
  }

  private writeHeaders(route: Route, principal: unknown, reply: HeaderWriter): void {
    if (marksOf(route).sensitive) {
      reply.header('cache-control', 'no-store');
    } else if (route.cache !== undefined && route.method === 'get') {
      reply.header('cache-control', cacheControlOf(route.cache));
      if (route.cache.vary.length > 0) reply.header('vary', route.cache.vary.join(', '));
    }
    if (route.access?.kind !== 'identified' || principal === null) return;
    const identity = this.guards.identities[route.access.identity.name];
    for (const [name, value] of Object.entries(identity?.responseHeadersFor?.(principal) ?? {})) {
      reply.header(name, value);
    }
  }
}
