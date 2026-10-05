import {
  Inject,
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import type { z } from 'zod';

import {
  CallerKind,
  cacheControlOf,
  restrictedFieldsOf,
  sensitivePathsOf,
  strippingBodiesOf,
  successStatusOf,
  type RestrictedField,
  type Route,
} from '@arthome/contracts/http';
import { ApiErrorCode } from '@arthome/core';

import {
  ENDPOINT_GUARDS,
  routeOf,
  routePrincipalOf,
  type EndpointGuards,
} from './endpoint-access.js';
import { refusalOf } from './refusal.js';
import { withoutPath } from './schema-paths.js';
import { answeredStatusOf, successStatusesOf } from './success-status.js';

/** The right every identified caller holds, so an `optionalAuth` route can restrict a field to it (ADR §6.3). */
export const SIGNED_IN_RIGHT = 'signedIn';

interface HeaderWriter {
  header(name: string, value: string): unknown;
}

interface SuccessMarks {
  readonly restricted: readonly RestrictedField[];
  readonly sensitive: boolean;
}

const marksByRoute = new WeakMap<Route, Map<number, SuccessMarks>>();

function marksOf(route: Route, status: number): SuccessMarks {
  const byStatus = marksByRoute.get(route) ?? new Map<number, SuccessMarks>();
  marksByRoute.set(route, byStatus);
  const known = byStatus.get(status);
  if (known !== undefined) return known;
  const schema = route.responses[status]?.content?.['application/json']?.schema;
  const marks = {
    restricted: schema === undefined ? [] : restrictedFieldsOf(schema),
    sensitive: schema !== undefined && sensitivePathsOf(schema).length > 0,
  };
  byStatus.set(status, marks);
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

function callerKindOf(principal: unknown): CallerKind {
  return principal === null || principal === undefined
    ? CallerKind.ANONYMOUS
    : CallerKind.IDENTIFIED;
}

function issueAt(issue: z.core.$ZodIssue): string {
  return `${issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')} ${issue.code}`;
}

/**
 * After the handler and the success envelope, so its paths are the declared body's: keeps only
 *   what the route's body for the status answered declares (ADR principle 2), a body outside it or
 *   an undeclared status answering 500; removes each restricted field the caller lacks the right
 *   for, absent rather than null (critical rule 11); and writes the headers the declaration
 *   implies: the freshness, `no-store` on an answer holding a sensitive field, and the identity's
 *   own (the rights version).
 */
@Injectable()
export class EndpointResponseInterceptor implements NestInterceptor {
  private readonly logger = new Logger(EndpointResponseInterceptor.name);

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
        const request = http.getRequest<object>();
        const status = answeredStatusOf(request) ?? successStatusOf(route);
        const declared = this.declaredBodyOf(route, status, body);
        const principal = route.access === undefined ? undefined : routePrincipalOf(request);
        this.writeHeaders(route, status, principal, http.getResponse<HeaderWriter>());
        const rights = rightsOf(principal);
        return marksOf(route, status)
          .restricted.filter(({ path, right }) => path !== '' && !rights.has(right))
          .reduce((projected, { path }) => withoutPath(projected, path), declared);
      }),
    );
  }

  /** The log names the paths and the rules broken, never a value: the body may hold a sensitive one. */
  private declaredBodyOf(route: Route, status: number, body: unknown): unknown {
    if (!successStatusesOf(route).includes(status)) {
      this.logger.error(
        `${route.operationId} answered ${String(status)}, which it does not declare; answered 500.`,
      );
      throw refusalOf(ApiErrorCode.INTERNAL);
    }
    const schema = strippingBodiesOf(route)[String(status)];
    if (schema === undefined) return body;
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    this.logger.error(
      `${route.operationId} answered outside its declared body, at ` +
        `${parsed.error.issues.map(issueAt).join(', ')}; answered 500.`,
    );
    throw refusalOf(ApiErrorCode.INTERNAL);
  }

  private writeHeaders(
    route: Route,
    status: number,
    principal: unknown,
    reply: HeaderWriter,
  ): void {
    if (marksOf(route, status).sensitive) {
      reply.header('cache-control', 'no-store');
    } else if (route.cache !== undefined && route.method === 'get') {
      reply.header('cache-control', cacheControlOf(route.cache, callerKindOf(principal)));
      if (route.cache.vary.length > 0) reply.header('vary', route.cache.vary.join(', '));
    }
    if (route.access?.kind !== 'identified' || principal === null) return;
    const identity = this.guards.identities[route.access.identity.name];
    for (const [name, value] of Object.entries(identity?.responseHeadersFor?.(principal) ?? {})) {
      reply.header(name, value);
    }
  }
}
