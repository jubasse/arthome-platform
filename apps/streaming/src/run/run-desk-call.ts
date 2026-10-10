import {
  deadlineExceededException,
  idempotentRequestOf,
  refusalOf,
  refuse,
  remainingBeforeDeadline,
  type DeclaredCodeOf,
} from '@arthome-platform/http-edge';

import type { RouteShape } from '@arthome/contracts/http';
import { ApiErrorCode, Surface, isDomainError, type Clock } from '@arthome/core';

import type { RunDeskCall } from './run-desk.commands.js';
import type { FeedSample, StreamingMetricsProvider } from '../media/media-ports.js';

/** What every write of the run desk relays: the deadline, the key, the surface, the trace. */
export interface RunDeskWrite {
  readonly operationId: string;
  readonly resourceId: string;
  readonly body: unknown;
  readonly statusCode: number;
  readonly headers: {
    readonly 'x-arthome-deadline': string;
    readonly 'idempotency-key'?: string;
    readonly 'x-arthome-actor-surface': Surface;
    readonly traceparent?: string;
  };
  readonly userId: string | null;
}

/**
 * The call a command carries, after transport.md §5.3's deadline is read: a past one is refused
 *   before any work. The fingerprint names the operation and its resource, so one key reused on
 *   another run or another move is refused rather than replayed.
 */
export function runDeskCallOf(write: RunDeskWrite, clock: Clock): RunDeskCall {
  const { headers } = write;
  remainingBeforeDeadline(headers['x-arthome-deadline'], clock);
  const operator = operatorOf(write);
  return {
    actor: { accountId: operator, surface: headers['x-arthome-actor-surface'] },
    idempotency: idempotentRequestOf(
      'POST',
      `${write.operationId}/${write.resourceId}`,
      write.body,
      write.statusCode,
      headers['idempotency-key'],
      operator,
    ),
    traceparent: headers.traceparent ?? null,
  };
}

/**
 * A 403 without a user, or on the `system` surface: a write of the run desk is an operator's act,
 *   which an automatic one must never read as, and the user scopes its idempotency.
 */
function operatorOf({ userId, headers }: RunDeskWrite): string {
  if (userId === null || headers['x-arthome-actor-surface'] === Surface.SYSTEM) {
    throw refusalOf(ApiErrorCode.FORBIDDEN);
  }
  return userId;
}

/** A domain refusal answered on its route's declaration: `refuse` logs a code it leaves out. */
export function refusedOn<R extends RouteShape>(route: R, error: unknown): unknown {
  if (!isDomainError(error)) return error;
  return refuse(route, error.code as DeclaredCodeOf<R>, error.params as never);
}

/** Called outside any transaction: a slow provider must never hold the run's row lock. */
export async function sampleWithin(
  remainingMs: number,
  metrics: StreamingMetricsProvider,
  streamPath: string,
): Promise<FeedSample | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(deadlineExceededException()), remainingMs);
  });
  try {
    return await Promise.race([metrics.sample(streamPath), late]);
  } finally {
    clearTimeout(timer);
  }
}
