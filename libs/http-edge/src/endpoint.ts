import type { IncomingHttpHeaders } from 'node:http';

import {
  Body,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  StandardSchemaValidationPipe,
  Version,
  applyDecorators,
  createParamDecorator,
  VersioningType,
  type ExecutionContext,
} from '@nestjs/common';
import { RouteConfig, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ApiHeader, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import {
  bodySchemaOf,
  headersSchemaOf,
  paramsSchemaOf,
  querySchemaOf,
  successStatusOf,
  versionedPath,
  type HandlerOutput,
  type HttpMethod,
  type Parameter,
  type Route,
  type RouteResponseBody,
  type RouteShape,
  type SecurityRequirement,
  type RouteSuccessStatus,
} from '@arthome/contracts/http';

import { EndpointRoute } from './endpoint-access.js';
import { schemaInvalidException } from './refusal.js';
import { requirementObjectOf } from './security-requirement.js';
import type { MemorisedResponse, SuccessEnvelope } from './success-envelope.interceptor.js';
import { answeredStatusOf } from './success-status.js';

const ROUTE_METHOD: Record<HttpMethod, (path: string) => MethodDecorator> = {
  get: Get,
  put: Put,
  post: Post,
  delete: Delete,
  patch: Patch,
};

/** `/dates/{dateId}` as the router reads it, `/dates/:dateId`: the version is Nest's, not the path's. */
function routerPathOf(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

/**
 * The body without its open index signatures: a response schema is loose so a client tolerates a
 *   new field, but an answer typed as an interface has no index signature to match it with.
 */
type Closed<T> = T extends readonly (infer Item)[]
  ? readonly Closed<Item>[]
  : T extends object
    ? { [K in keyof T as string extends K ? never : K]: Closed<T[K]> }
    : T;

type SuccessBody<R extends RouteShape> = Closed<RouteResponseBody<R, RouteSuccessStatus<R>>>;

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

interface Outside<R extends RouteShape> {
  readonly 'the handler answers outside its route': HandlerOutput<R>;
}

/**
 * A replay answers the stored envelope, so it is checked whole, and only on a route with one
 *   success status: it carries no status to replay. Anything else is core's `HandlerOutput`.
 */
type Answers<R extends RouteShape, Answer> =
  Answer extends MemorisedResponse<infer Data>
    ? true extends IsUnion<RouteSuccessStatus<R>>
      ? { readonly 'a memorised answer replays one success status': RouteSuccessStatus<R> }
      : [SuccessEnvelope<Data>] extends [SuccessBody<R>]
        ? true
        : Outside<R>
    : [Answer] extends [HandlerOutput<R>]
      ? true
      : Outside<R>;

/** `unknown` when the handler returns what its route owes; a named mismatch otherwise. */
type AnswerCheck<R extends RouteShape, Handler> = Handler extends (
  ...args: never[]
) => Promise<infer Answer>
  ? Answers<R, Answer> extends true
    ? unknown
    : Exclude<Answers<R, Answer>, true>
  : { readonly 'the handler answers outside its route': 'it must be async' };

export type EndpointDecorator<R extends RouteShape> = <
  Handler extends (...args: never[]) => Promise<unknown>,
>(
  target: object,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<Handler> & AnswerCheck<R, NoInfer<Handler>>,
) => void;

/** The Fastify route config key `Endpoint` writes a route's body ceiling under. */
const BODY_LIMIT_CONFIG = 'arthomeBodyLimit';

/**
 * What an app serving `Endpoint` routes needs before `init()`: URI versioning, which `Endpoint`'s
 *   `Version` needs; each route's body ceiling as its Fastify `bodyLimit`, which only an `onRoute`
 *   hook can set, as Nest registers the route; and the success status a handler chose among its
 *   route's several. Call before `mountDevDocs`, whose document is built after it.
 */
export function serveEndpoints(app: NestFastifyApplication): void {
  app.enableVersioning({ type: VersioningType.URI });
  const instance = app.getHttpAdapter().getInstance();
  instance.addHook('onRoute', (options) => {
    const limit: unknown = (options.config as Readonly<Record<string, unknown>> | undefined)?.[
      BODY_LIMIT_CONFIG
    ];
    // eslint-disable-next-line no-param-reassign -- an onRoute hook configures the route by mutating its options.
    if (typeof limit === 'number') options.bodyLimit = limit;
  });
  // Nest re-applies the route's `@HttpCode` after the handler returns (`FastifyAdapter.reply`,
  //   Nest 12.0.3), so only a hook can send another status; a refusal raised after the handler
  //   chose keeps its own.
  instance.addHook('onSend', async (request, reply, payload) => {
    const status = answeredStatusOf(request);
    const succeeded = reply.statusCode >= 200 && reply.statusCode < 300;
    // Not awaited: a Fastify reply is thenable, and awaiting it here waits for its own send.
    if (status !== undefined && succeeded) void reply.code(status);
    return payload;
  });
}

/** `{}` is a call with no credential at all, which a decorator spells as an empty requirement. */
function securityOf(requirements: readonly SecurityRequirement[]): MethodDecorator[] {
  if (requirements.length === 0) return [ApiSecurity({})];
  return requirements.map((requirement) => ApiSecurity(requirementObjectOf(requirement)));
}

function inputJsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  });
  return jsonSchema;
}

/** Only headers: a path and a query parameter are documented from the pipe's schema. */
function headerDocumentationOf(parameter: Parameter): MethodDecorator {
  return ApiHeader({
    name: parameter.name,
    required: parameter.required === true,
    ...(parameter.description !== undefined && { description: parameter.description }),
    schema: inputJsonSchemaOf(parameter.schema),
  });
}

function responseDocumentationOf(route: RouteShape): MethodDecorator[] {
  return Object.entries(route.responses).map(([status, response]) => {
    const schema = response.content?.['application/json']?.schema;
    return ApiResponse({
      status: Number(status),
      description: response.description,
      ...(schema !== undefined && { standardSchema: schema }),
    });
  });
}

/**
 * Binds a handler to its route, with real NestJS and `@nestjs/swagger` decorators only: the
 *   method, the path and the success status come from the contract, the document is filled from
 *   it (operation id, summary, tags, one response per declared status, security, headers), and the compiler
 *   refuses a handler that does not return core's `HandlerOutput` of the route: its success body
 *   without `servedAt`, which `SuccessEnvelopeInterceptor` stamps, or `{ status, body }` on a
 *   route declaring several success statuses.
 */
export function Endpoint<R extends Route>(route: R): EndpointDecorator<R> {
  const decorators = applyDecorators(
    EndpointRoute(route),
    ROUTE_METHOD[route.method](routerPathOf(route.path)),
    ...(route.bodyLimit === undefined
      ? []
      : [RouteConfig({ [BODY_LIMIT_CONFIG]: route.bodyLimit })]),
    Version(String(route.version)),
    HttpCode(successStatusOf(route)),
    // The description is the api's docs module's: `mountDevDocs` writes it, with the doc-only meta.
    ApiOperation({
      operationId: route.operationId,
      ...(route.summary !== undefined && { summary: route.summary }),
      ...(route.deprecated === true && { deprecated: true }),
    }),
    ...(route.tags === undefined ? [] : [ApiTags(...route.tags)]),
    ...responseDocumentationOf(route),
    ...(route.security === undefined ? [] : securityOf(route.security)),
    ...(route.parameters ?? [])
      .filter((parameter) => parameter.in === 'header')
      .map(headerDocumentationOf),
  );
  return (target, key, descriptor) => {
    decorators(target, key, descriptor);
  };
}

/** The schema of the route's success body: what a relay validates an upstream answer against. */
export function successSchemaOf<R extends RouteShape>(
  route: R,
): z.ZodType<RouteResponseBody<R, RouteSuccessStatus<R>>, unknown> {
  const schema = route.responses[successStatusOf(route)]?.content?.['application/json']?.schema;
  if (schema === undefined) {
    throw new Error(`${route.method.toUpperCase()} ${versionedPath(route)} answers no JSON body.`);
  }
  return schema as z.ZodType<RouteResponseBody<R, RouteSuccessStatus<R>>, unknown>;
}

/**
 * Validated by the app's global `StandardSchemaValidationPipe`, as `@Query({ schema })` is.
 * @deprecated `EndpointInput(route)` hands every part of the input, validated at once.
 */
export function EndpointQuery(route: RouteShape): ParameterDecorator {
  return Query({ schema: querySchemaOf(route) });
}

/** @deprecated `EndpointInput(route)` hands every part of the input, validated at once. */
export function EndpointParams(route: RouteShape): ParameterDecorator {
  return Param({ schema: paramsSchemaOf(route) });
}

/** @deprecated `EndpointInput(route)` hands every part of the input, validated at once. */
export function EndpointBody(route: RouteShape): ParameterDecorator {
  const schema = bodySchemaOf(route);
  return schema === undefined ? Body() : Body({ schema });
}

const requestHeaders = createParamDecorator(
  (_data: unknown, context: ExecutionContext): IncomingHttpHeaders =>
    context.switchToHttp().getRequest<{ readonly headers: IncomingHttpHeaders }>().headers,
);

/**
 * `@Headers()` takes no schema, and the global pipe skips a custom decorator, so this one carries
 *   its own pipe with the same `exceptionFactory`: a refused header answers
 *   `api.schema_invalid` naming it, like any other field.
 */
const VALIDATED_HEADERS = new StandardSchemaValidationPipe({
  validateCustomDecorators: true,
  exceptionFactory: schemaInvalidException,
});

/** @deprecated `EndpointInput(route)` hands every part of the input, validated at once. */
export function EndpointHeaders(route: RouteShape): ParameterDecorator {
  return requestHeaders({ schema: headersSchemaOf(route), pipes: [VALIDATED_HEADERS] });
}
