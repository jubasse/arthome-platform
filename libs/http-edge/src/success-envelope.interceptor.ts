import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';

import type { Route } from '@arthome/contracts/http';
import type { Clock } from '@arthome/core';

import { routeOf } from './endpoint-access.js';
import { answerWithStatus, successStatusesOf } from './success-status.js';

export interface SuccessEnvelope<T> {
  readonly servedAt: string;
  /** The aggregate's version after a conditional command, at the root (transport.md §5.5). */
  readonly version?: number;
  readonly data: T;
}

/**
 * An envelope built inside the command's transaction, so it could be stored with the write it
 * answers and replayed verbatim, `servedAt` included (transport.md §5.4).
 */
export class MemorisedResponse<T> {
  public constructor(
    public readonly envelope: SuccessEnvelope<T>,
    public readonly replayed: boolean,
  ) {}
}

/**
 * A collection's fields sit at the envelope's root beside `servedAt` — `items` + `page`, or a
 * search's `groups` + `facets` + `page` — never under `data` (§5.5). `validUntil` is the
 * instant the first perishable value in it stops being true.
 */
export class CollectionResponse<T extends object> {
  public constructor(
    public readonly fields: T,
    public readonly validUntil: string | null,
  ) {}
}

/** A single resource under `data`, with the instant its first perishable value expires (§5.5). */
export class PerishableResponse<T> {
  public constructor(
    public readonly data: T,
    public readonly validUntil: string | null,
  ) {}
}

interface HeaderWriter {
  header(name: string, value: string): unknown;
}

/**
 * A replayed write's headers: `Idempotency-Replayed`, and `X-Arthome-Served-At` for when this
 *   answer was served, the stored body's `servedAt` being the first attempt's.
 */
export function markReplayed(reply: HeaderWriter, clock: Clock): void {
  reply.header('Idempotency-Replayed', 'true');
  reply.header('x-arthome-served-at', clock.now());
}

function unwrapAnsweredStatus(route: Route, output: unknown, context: ExecutionContext): unknown {
  if (successStatusesOf(route).length < 2) return output;
  const { status, body } = output as { readonly status: number; readonly body: unknown };
  answerWithStatus(context.switchToHttp().getRequest<object>(), status);
  return body;
}

/**
 * transport.md §5.5's success envelope, applied once rather than remembered per route. A handler
 *   bound by `Endpoint` returns its route's body without `servedAt` (core's `HandlerOutput`), which
 *   is stamped on it, or `{ status, body }` where the route declares several success statuses, whose
 *   status `serveEndpoints` sends; any other handler's value is wrapped.
 */
@Injectable()
export class SuccessEnvelopeInterceptor implements NestInterceptor {
  public constructor(
    private readonly clock: Clock,
    private readonly reflector: Reflector = new Reflector(),
  ) {}

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // A global interceptor reaches WS messages and RPC handlers too
    //   (`nestjs-request-pipeline` rule 5), and neither carries this envelope.
    if (context.getType() !== 'http') return next.handle();
    const route = routeOf(this.reflector, context);

    // Through the `Clock` port, never `new Date()`, so a `FixedClock` can assert `servedAt` —
    // the same reason the error filter takes one.
    return next.handle().pipe(
      map((data: unknown) => {
        if (route !== undefined && !(data instanceof MemorisedResponse)) {
          const body = unwrapAnsweredStatus(route, data, context);
          return body === undefined
            ? undefined
            : { servedAt: this.clock.now(), ...(body as object) };
        }
        if (data instanceof CollectionResponse) {
          const { fields, validUntil } = data as CollectionResponse<object>;
          return {
            servedAt: this.clock.now(),
            ...(validUntil !== null && { validUntil }),
            ...fields,
          };
        }
        if (data instanceof PerishableResponse) {
          const { data: resource, validUntil } = data as PerishableResponse<unknown>;
          return {
            servedAt: this.clock.now(),
            ...(validUntil !== null && { validUntil }),
            data: resource,
          };
        }
        if (!(data instanceof MemorisedResponse)) return { servedAt: this.clock.now(), data };
        if (data.replayed) {
          markReplayed(context.switchToHttp().getResponse<HeaderWriter>(), this.clock);
        }
        return data.envelope;
      }),
    );
  }
}
