import {
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Put,
  Version,
  applyDecorators,
  VersioningType,
} from '@nestjs/common';
import { RouteConfig, type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';

import {
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
    target: 'openapi-3.0',
    io: 'input',
    unrepresentable: 'any',
  });
  return jsonSchema;
}

function parameterDocumentationOf(parameter: Parameter): MethodDecorator[] {
  const documented = {
    name: parameter.name,
    required: parameter.in === 'path' || parameter.required === true,
    ...(parameter.description !== undefined && { description: parameter.description }),
    schema: inputJsonSchemaOf(parameter.schema),
  };
  switch (parameter.in) {
    case 'path':
      return [ApiParam(documented)];
    case 'query':
      return [ApiQuery(documented)];
    case 'header':
      return [ApiHeader(documented)];
    case 'cookie':
      return [];
  }
}

/**
 * Swagger reads the inputs of `@Param`, `@Query` and `@Body`, never of a custom decorator such as
 *   `EndpointInput`: each declared parameter and the body are documented from the route instead.
 *   A cookie is the session's, documented by its security scheme.
 */
function inputDocumentationOf(route: RouteShape): MethodDecorator[] {
  const parameters = (route.parameters ?? []).flatMap(parameterDocumentationOf);
  const body = route.requestBody?.content['application/json'];
  if (body === undefined) return parameters;
  return [
    ...parameters,
    ApiBody({
      required: route.requestBody?.required === true,
      schema: inputJsonSchemaOf(body.schema),
    }),
  ];
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
 *   it (operation id, summary, tags, one response per declared status, security, parameters and
 *   body), and the compiler refuses a handler that does not return core's `HandlerOutput` of the
 *   route: its success body without `servedAt`, which `SuccessEnvelopeInterceptor` stamps, or
 *   `{ status, body }` on a route declaring several success statuses.
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
    ...inputDocumentationOf(route),
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
