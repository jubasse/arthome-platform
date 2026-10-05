import { createParamDecorator, type ExecutionContext, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

import {
  bodySchemaOf,
  headersSchemaOf,
  paramsSchemaOf,
  querySchemaOf,
  type Route,
} from '@arthome/contracts/http';

import { routePrincipalOf } from './endpoint-access.js';
import { schemaInvalidException } from './refusal.js';

interface InboundRequest {
  readonly params?: unknown;
  readonly query?: unknown;
  readonly headers?: unknown;
  readonly body?: unknown;
}

interface Input {
  readonly params: unknown;
  readonly query: unknown;
  readonly headers: unknown;
  readonly body: unknown;
  readonly principal: unknown;
}

function principalOfRoute(route: Route, request: object): unknown {
  return route.access === undefined ? undefined : routePrincipalOf(request);
}

const rawInput = createParamDecorator((route: Route, context: ExecutionContext): Input => {
  const request = context.switchToHttp().getRequest<InboundRequest & object>();
  return {
    params: request.params ?? {},
    query: request.query ?? {},
    headers: request.headers ?? {},
    body: request.body,
    principal: principalOfRoute(route, request),
  };
});

type Issues = readonly z.core.$ZodIssue[];

async function parsed(
  schema: z.ZodType | undefined,
  value: unknown,
): Promise<{ readonly value: unknown; readonly issues: Issues }> {
  if (schema === undefined) return { value: undefined, issues: [] };
  const result = await schema.safeParseAsync(value);
  return result.success
    ? { value: result.data, issues: [] }
    : { value: undefined, issues: result.error.issues };
}

/**
 * Each part against the route's schema, every failing field named at once: a custom decorator is
 *   skipped by the global pipe, so this one carries its own.
 */
class EndpointInputPipe implements PipeTransform<Input, Promise<Input>> {
  public constructor(private readonly route: Route) {}

  public async transform(input: Input): Promise<Input> {
    const { route } = this;
    const [params, query, headers, body] = await Promise.all([
      parsed(paramsSchemaOf(route), input.params),
      parsed(querySchemaOf(route), input.query),
      parsed(headersSchemaOf(route), input.headers),
      parsed(bodySchemaOf(route), input.body),
    ]);
    const issues = [...params.issues, ...query.issues, ...headers.issues, ...body.issues];
    if (issues.length > 0) throw schemaInvalidException(issues);
    return {
      params: params.value,
      query: query.value,
      headers: headers.value,
      body: body.value,
      principal: input.principal,
    };
  }
}

/** `{ params, query, body, headers, principal }`, validated and typed by `HandlerInput<typeof route>`. */
export function EndpointInput(route: Route): ParameterDecorator {
  return rawInput(route, new EndpointInputPipe(route));
}

/** The caller the route's identity resolved: `null` only on an `optionalAuth` route. */
export function EndpointPrincipal(route: Route): ParameterDecorator {
  if (route.access === undefined) {
    throw new Error(`EndpointPrincipal: ${route.operationId} declares no access.`);
  }
  return createParamDecorator((_data: unknown, context: ExecutionContext): unknown =>
    routePrincipalOf(context.switchToHttp().getRequest<object>()),
  )();
}
