import type { ServerResponse } from 'node:http';

import { HttpStatus } from '@nestjs/common';

import { ApiErrorCode, FailureNature, type Clock } from '@arthome/core';
import { InstantIn } from '@arthome/core/schema';

import { RefusalException, schemaInvalidRefusal } from './refusal.js';

export const DEADLINE_HEADER = 'x-arthome-deadline';

export function deadlineExceededException(): RefusalException {
  return new RefusalException(HttpStatus.GATEWAY_TIMEOUT, {
    code: ApiErrorCode.DEADLINE_EXCEEDED,
    params: {},
    nature: FailureNature.UNAVAILABLE,
  });
}

/**
 * transport.md §5.3's instant, read before any work: absent or unreadable is a malformed call,
 * already past is refused rather than served to nobody. Returns the milliseconds left.
 */
export function remainingBeforeDeadline(header: string | undefined, clock: Clock): number {
  if (!InstantIn.safeParse(header).success) {
    throw new RefusalException(
      HttpStatus.BAD_REQUEST,
      schemaInvalidRefusal([{ path: [DEADLINE_HEADER] }]),
    );
  }
  const remaining = Date.parse(header ?? '') - clock.nowMs();
  if (remaining <= 0) throw deadlineExceededException();
  return remaining;
}

/**
 * §5.3's third obligation: aborted when the caller hangs up before the response is written, so
 *   the work it was waiting for can stop. The response and not the request: measured on Node
 *   24.19, a GET's request emitted `close` 20 ms in, 100 ms before its response, caller still there.
 */
export function whenCallerLeaves(response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  response.once('close', () => {
    if (!response.writableFinished) controller.abort();
  });
  return controller.signal;
}
