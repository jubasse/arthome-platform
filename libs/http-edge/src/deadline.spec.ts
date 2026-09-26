import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';

import { ApiErrorCode, FixedClock } from '@arthome/core';

import { remainingBeforeDeadline, whenCallerLeaves } from './deadline.js';
import { RefusalException } from './refusal.js';

const clock = new FixedClock('2026-09-26T20:00:00.000Z');

function refusalOf(header: string | undefined): RefusalException {
  try {
    remainingBeforeDeadline(header, clock);
  } catch (error) {
    if (error instanceof RefusalException) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('remainingBeforeDeadline', () => {
  it('gives the milliseconds left before the instant', () => {
    expect(remainingBeforeDeadline('2026-09-26T20:00:00.200Z', clock)).toBe(200);
  });

  it('refuses a deadline already reached with a 504, before any work', () => {
    for (const header of ['2026-09-26T20:00:00.000Z', '2026-09-26T19:59:59.000Z']) {
      const refusal = refusalOf(header);
      expect(refusal.getStatus()).toBe(504);
      expect(refusal.refusal.code).toBe(ApiErrorCode.DEADLINE_EXCEEDED);
    }
  });

  it('refuses a call without one, or with a duration or an offset, as malformed', () => {
    for (const header of [undefined, '200ms', '2026-09-26T22:00:00.000+02:00']) {
      const refusal = refusalOf(header);
      expect(refusal.getStatus()).toBe(400);
      expect(refusal.refusal).toMatchObject({
        code: ApiErrorCode.SCHEMA_INVALID,
        params: { fields: ['x-arthome-deadline'] },
      });
    }
  });
});

describe('whenCallerLeaves', () => {
  function response(writableFinished: boolean): ServerResponse {
    return Object.assign(new EventEmitter(), { writableFinished }) as unknown as ServerResponse;
  }

  it('aborts when the connection closes before the response is written', () => {
    const hungUp = response(false);
    const signal = whenCallerLeaves(hungUp);

    hungUp.emit('close');

    expect(signal.aborted).toBe(true);
  });

  it('stays quiet when the close follows a response written in full', () => {
    const served = response(true);
    const signal = whenCallerLeaves(served);

    served.emit('close');

    expect(signal.aborted).toBe(false);
  });
});
