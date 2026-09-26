import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';

import type { Clock } from '@arthome/core';

export interface SuccessEnvelope<T> {
  readonly servedAt: string;
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

interface HeaderWriter {
  header(name: string, value: string): unknown;
}

/**
 * transport.md §5.5's success envelope, applied once rather than remembered per route.
 *
 * `validUntil` is absent because no route here returns a perishable value. §5.5 makes it
 *   conditional — "as soon as a perishable value is present" — so the first route that serves one
 *   adds it, and inventing the mechanism now would be shape ahead of use.
 */
@Injectable()
export class SuccessEnvelopeInterceptor implements NestInterceptor {
  public constructor(private readonly clock: Clock) {}

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // A global interceptor reaches WS messages and RPC handlers too
    //   (`nestjs-request-pipeline` rule 5), and neither carries this envelope.
    if (context.getType() !== 'http') return next.handle();

    // Through the `Clock` port, never `new Date()`, so a `FixedClock` can assert `servedAt` —
    // the same reason the error filter takes one.
    return next.handle().pipe(
      map((data: unknown) => {
        if (!(data instanceof MemorisedResponse)) return { servedAt: this.clock.now(), data };
        if (data.replayed) {
          // The body's `servedAt` is the first attempt's; this header says when the replay was.
          const reply = context.switchToHttp().getResponse<HeaderWriter>();
          reply.header('Idempotency-Replayed', 'true');
          reply.header('x-arthome-served-at', this.clock.now());
        }
        return data.envelope;
      }),
    );
  }
}
