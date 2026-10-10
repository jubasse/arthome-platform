import {
  idempotentRequestOf,
  refuse,
  remainingBeforeDeadline,
  type DeclaredCodeOf,
} from '@arthome-platform/http-edge';

import type { RouteShape } from '@arthome/contracts/http';
import { isDomainError, type Clock, type Surface } from '@arthome/core';

import type { RunDeskCall } from './run-desk.commands.js';

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
  return {
    actor: { accountId: write.userId, surface: headers['x-arthome-actor-surface'] },
    idempotency: idempotentRequestOf(
      'POST',
      `${write.operationId}/${write.resourceId}`,
      write.body,
      write.statusCode,
      headers['idempotency-key'],
      write.userId,
    ),
    traceparent: headers.traceparent ?? null,
  };
}

/** A domain refusal answered on its route's declaration: `refuse` logs a code it leaves out. */
export function refusedOn<R extends RouteShape>(route: R, error: unknown): unknown {
  if (!isDomainError(error)) return error;
  return refuse(route, error.code as DeclaredCodeOf<R>, error.params as never);
}
