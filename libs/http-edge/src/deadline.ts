import type { ServerResponse } from 'node:http';

import { ApiErrorCode, SchemaIssueRule, type Clock } from '@arthome/core';
import { InstantIn } from '@arthome/core/schema';

import { refusalOf, type RefusalException } from './refusal.js';

export const DEADLINE_HEADER = 'x-arthome-deadline';

export function deadlineExceededException(): RefusalException {
  return refusalOf(ApiErrorCode.DEADLINE_EXCEEDED);
}

/**
 * transport.md §5.3's instant, read before any work: absent or unreadable is a malformed call,
 * already past is refused rather than served to nobody. Returns the milliseconds left.
 */
export function remainingBeforeDeadline(header: string | undefined, clock: Clock): number {
  if (!InstantIn.safeParse(header).success) {
    throw refusalOf(ApiErrorCode.SCHEMA_INVALID, {
      issues: [
        header === undefined
          ? { path: [DEADLINE_HEADER], rule: SchemaIssueRule.INVALID_TYPE }
          : { path: [DEADLINE_HEADER], rule: SchemaIssueRule.INVALID_FORMAT, format: 'date-time' },
      ],
    });
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
