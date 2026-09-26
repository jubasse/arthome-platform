import { RefusalException, schemaInvalidException } from '@arthome-platform/http-edge';
import { StandardSchemaValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ApiErrorCode, FailureNature } from '@arthome/core';

import { RegisterAccountSchema } from './register-account.schema.js';

const pipe = new StandardSchemaValidationPipe({ exceptionFactory: schemaInvalidException });

const metadata = {
  type: 'body',
  schema: RegisterAccountSchema,
} as const satisfies ArgumentMetadata;

const body = {
  publicHandle: '@marie.j',
  email: 'marie@example.test',
  locale: 'fr',
  country: 'FR',
};

async function refusalFor(candidate: unknown): Promise<RefusalException> {
  try {
    await pipe.transform(candidate, metadata);
  } catch (error: unknown) {
    if (error instanceof RefusalException) {
      return error;
    }
    throw error;
  }
  throw new Error('the body was accepted, and this case exists because it must not be');
}

describe('the POST /accounts body', () => {
  it('accepts the body the event-path walkthrough posts', async () => {
    await expect(pipe.transform(body, metadata)).resolves.toEqual(body);
  });

  it('refuses a locale that is an object, which used to be stored and published as two different values', async () => {
    const refusal = await refusalFor({ ...body, locale: { a: 1 } });

    expect(refusal.getStatus()).toBe(400);
    expect(refusal.refusal.params).toEqual({ fields: ['locale'] });
  });

  it('refuses a locale outside the vocabulary, because a write cannot store a value no rule evaluates', async () => {
    const refusal = await refusalFor({ ...body, locale: 'de' });
    expect(refusal.refusal.params).toEqual({ fields: ['locale'] });
  });

  it('refuses a handle that is not a handle', async () => {
    await expect(refusalFor({ ...body, publicHandle: 'marie.j' })).resolves.toBeDefined();
  });

  it('refuses a country that is not two upper-case letters, and accepts one that is merely unassigned', async () => {
    await expect(refusalFor({ ...body, country: 'FRA' })).resolves.toBeDefined();
    await expect(refusalFor({ ...body, country: 'fr' })).resolves.toBeDefined();
    await expect(pipe.transform({ ...body, country: 'ZZ' }, metadata)).resolves.toBeDefined();
  });

  it('refuses an unknown field rather than dropping it', async () => {
    const refusal = await refusalFor({ ...body, isAdmin: true });
    expect(refusal.getStatus()).toBe(400);
    expect(refusal.refusal.code).toBe(ApiErrorCode.SCHEMA_INVALID);
  });

  it('refuses an unknown field WITHOUT naming it, and that is a limit of the pipe rather than a choice', async () => {
    // MEASURED: zod reports this as `{ code: 'unrecognized_keys', keys: ['isAdmin'],
    //   path: [] }`, and `params.fields` is built from `path`. The key is in `keys`, which
    //   Standard Schema's `Issue` type does not declare, so no validator can name it.
    const refusal = await refusalFor({ ...body, isAdmin: true });
    expect(refusal.refusal.params).toEqual({});
  });

  it('names every field that failed, sorted, so two identical bad bodies answer identically', async () => {
    const refusal = await refusalFor({ publicHandle: 1, email: 2, locale: 3, country: 4 });
    expect(refusal.refusal.params).toEqual({
      fields: ['country', 'email', 'locale', 'publicHandle'],
    });
  });

  it('carries a code and a nature, and not one word of the validation library', async () => {
    const refusal = await refusalFor({ ...body, locale: { a: 1 } });

    expect(refusal.refusal.code).toBe(ApiErrorCode.SCHEMA_INVALID);
    expect(refusal.refusal.nature).toBe(FailureNature.REFUSED);
    // zod's own wording here is "Invalid input: expected string, received object".
    const served = JSON.stringify(refusal.refusal);
    expect(served).not.toMatch(/invalid input|expected|received/i);
  });

  it('gives the caller a branchable id on the exception itself', async () => {
    const refusal = await refusalFor({ ...body, locale: { a: 1 } });
    // `errorCode` reaches the body only when the exception is built from a STRING message,
    //   and only on @nestjs/common >= 12.0.2.
    expect(refusal.errorCode).toBe(ApiErrorCode.SCHEMA_INVALID);
  });
});
