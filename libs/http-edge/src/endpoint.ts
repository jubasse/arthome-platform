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
  applyDecorators,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';

import {
  bodySchemaOf,
  headersSchemaOf,
  paramsSchemaOf,
  querySchemaOf,
  successStatusOf,
  type HttpMethod,
  type RouteResponseBody,
  type RouteShape,
  type RouteSuccessStatus,
} from '@arthome/contracts/http';

import { schemaInvalidException } from './refusal.js';
import type {
  CollectionResponse,
  MemorisedResponse,
  PerishableResponse,
  SuccessEnvelope,
} from './success-envelope.interceptor.js';

const ROUTE_METHOD: Record<HttpMethod, (path: string) => MethodDecorator> = {
  get: Get,
  put: Put,
  post: Post,
  delete: Delete,
  patch: Patch,
};

/** `/v1/dates/{dateId}` as the router reads it, `/v1/dates/:dateId`. */
function routerPathOf(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

interface EnvelopeInstants {
  readonly servedAt: string;
  readonly validUntil?: string;
}

/** What `SuccessEnvelopeInterceptor` sends for what a handler returns. */
type Enveloped<Answer> =
  Answer extends CollectionResponse<infer Fields>
    ? EnvelopeInstants & Fields
    : Answer extends PerishableResponse<infer Data>
      ? EnvelopeInstants & { readonly data: Data }
      : Answer extends MemorisedResponse<infer Data>
        ? SuccessEnvelope<Data>
        : { readonly servedAt: string; readonly data: Answer };

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

/** `unknown` when the handler's answer, enveloped, is the route's success body; a named mismatch otherwise. */
type AnswerCheck<R extends RouteShape, Handler> = Handler extends (
  ...args: never[]
) => Promise<infer Answer>
  ? [Enveloped<Answer>] extends [SuccessBody<R>]
    ? unknown
    : { readonly 'the handler answers outside its route': SuccessBody<R> }
  : { readonly 'the handler answers outside its route': 'it must be async' };

export type EndpointDecorator<R extends RouteShape> = <
  Handler extends (...args: never[]) => Promise<unknown>,
>(
  target: object,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<Handler> & AnswerCheck<R, NoInfer<Handler>>,
) => void;

/**
 * Binds a handler to its route: the method, the path and the success status come from the
 *   contract, and the compiler refuses a handler whose answer, once enveloped, is not the route's
 *   success body. Its inputs are bound by the `Endpoint*` parameter decorators below.
 */
export function Endpoint<R extends RouteShape>(route: R): EndpointDecorator<R> {
  const decorators = applyDecorators(
    ROUTE_METHOD[route.method](routerPathOf(route.path)),
    HttpCode(successStatusOf(route)),
  );
  return (target, key, descriptor) => {
    decorators(target, key, descriptor);
  };
}

/** Validated by the app's global `StandardSchemaValidationPipe`, as `@Query({ schema })` is. */
export function EndpointQuery(route: RouteShape): ParameterDecorator {
  return Query({ schema: querySchemaOf(route) });
}

export function EndpointParams(route: RouteShape): ParameterDecorator {
  return Param({ schema: paramsSchemaOf(route) });
}

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

export function EndpointHeaders(route: RouteShape): ParameterDecorator {
  return requestHeaders({ schema: headersSchemaOf(route), pipes: [VALIDATED_HEADERS] });
}
