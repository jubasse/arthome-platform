import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { DomainError, DomainErrorCode, FailureNature } from '@arthome/core';

import { asConflict } from './conflict.js';
import { RefusalException } from './refusal.js';

class ListedRefusal extends DomainError {
  public constructor(public readonly missing: readonly string[]) {
    super({ code: DomainErrorCode.PUBLICATION_CHECKLIST_INCOMPLETE });
  }
}

async function refusalOf(decided: Promise<unknown>): Promise<RefusalException> {
  try {
    await decided;
  } catch (error) {
    if (error instanceof RefusalException) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('asConflict', () => {
  it('answers what was decided', async () => {
    expect(await asConflict(() => 4)).toBe(4);
    expect(await asConflict(() => Promise.resolve('saved'))).toBe('saved');
  });

  it('answers a domain refusal 409, its code, params and nature kept', async () => {
    const refusal = await refusalOf(
      asConflict(() => {
        throw new DomainError({ code: DomainErrorCode.STATE_CONFLICT, params: { version: 3 } });
      }),
    );

    expect(refusal.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(refusal.refusal).toEqual({
      code: DomainErrorCode.STATE_CONFLICT,
      params: { version: 3 },
      nature: FailureNature.REFUSED,
    });
  });

  it('takes the params a refusal carries beside core’s from the mapper it is given', async () => {
    const refusal = await refusalOf(
      asConflict(
        () => Promise.reject(new ListedRefusal(['capacity'])),
        (error) => (error instanceof ListedRefusal ? { missing: error.missing } : error.params),
      ),
    );

    expect(refusal.refusal.params).toEqual({ missing: ['capacity'] });
  });

  it('leaves any other failure as it was thrown', async () => {
    const fault = new Error('pool closed');

    await expect(asConflict(() => Promise.reject(fault))).rejects.toBe(fault);
  });
});
