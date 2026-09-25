import { RefusalException, schemaInvalidException } from '@arthome-platform/http-edge';
import { StandardSchemaValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ApiErrorCode, FailureNature } from '@arthome/core';

import { RegisterAccountSchema } from './register-account.schema.js';

/**
 * The pipe as `AppModule` binds it, so these cases exercise the real mechanism
 * rather than the schema alone. A schema that refuses a body while the pipe is
 * absent refuses nothing: the parameter's schema is only metadata, and this pipe
 * is what reads it.
 */
const pipe = new StandardSchemaValidationPipe({ exceptionFactory: schemaInvalidException });

const metadata = {
  type: 'body',
  schema: RegisterAccountSchema,
} as const satisfies ArgumentMetadata;

/** The body `AGENTS.md`'s event-path walkthrough posts, field for field. */
const body = {
  publicHandle: '@marie.j',
  email: 'marie@example.test',
  locale: 'fr',
  country: 'FR',
};

/** The refusal the pipe raised, so a case can assert on the code rather than on a message. */
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
    // ⚠ THE CASE THIS WHOLE FILE EXISTS FOR. `{"a":1}` reached the database and
    //   the broker with no error at any hop, and they disagreed for good: `pg`
    //   sent the object through `JSON.stringify`, so `locale text` held `{"a":1}`,
    //   while protobuf's writer coerced it with `String(value)`, so the event
    //   carried `[object Object]` — and that is the one
    //   `notifications.welcome_email` received.
    const refusal = await refusalFor({ ...body, locale: { a: 1 } });

    expect(refusal.getStatus()).toBe(400);
    expect(refusal.refusal.params).toEqual({ fields: ['locale'] });
  });

  it('refuses a locale outside the vocabulary, because a write cannot store a value no rule evaluates', async () => {
    // `de` is a plausible BCP 47 tag and not a member: `LOCALES` is `fr` and `en`.
    // An account created with it had no welcome-email template. This is the `In`
    // side, where member strictness is correct — critical-rules #10's tolerance is
    // the `Out` rule.
    const refusal = await refusalFor({ ...body, locale: 'de' });
    expect(refusal.refusal.params).toEqual({ fields: ['locale'] });
  });

  it('refuses a handle that is not a handle', async () => {
    // No leading `@`: `PublicHandleSchema` requires it, and this value is the one
    // the route now RETURNS, so a malformed one would be echoed to the caller.
    await expect(refusalFor({ ...body, publicHandle: 'marie.j' })).resolves.toBeDefined();
  });

  it('refuses a country that is not two upper-case letters, and accepts one that is merely unassigned', async () => {
    await expect(refusalFor({ ...body, country: 'FRA' })).resolves.toBeDefined();
    await expect(refusalFor({ ...body, country: 'fr' })).resolves.toBeDefined();
    // ⚠ `ZZ` PASSES, AND THAT IS THE DECISION. The shape is checked, the ISO
    //   membership is not: 3166-1 has some 250 members and moves, and
    //   `@arthome/core` publishes no vocabulary for it, so a list written here
    //   would be a parallel table going stale inside one service.
    await expect(pipe.transform({ ...body, country: 'ZZ' }, metadata)).resolves.toBeDefined();
  });

  it('refuses an unknown field rather than dropping it', async () => {
    // `z.strictObject`, not `z.object`. A stripping schema would accept
    // `publichandle` silently and register an account whose handle is undefined —
    // the mass-assignment case read from the other direction.
    const refusal = await refusalFor({ ...body, isAdmin: true });
    expect(refusal.getStatus()).toBe(400);
    expect(refusal.refusal.code).toBe(ApiErrorCode.SCHEMA_INVALID);
  });

  it('refuses an unknown field WITHOUT naming it, and that is a limit of the pipe rather than a choice', async () => {
    // ⚠ MEASURED, NOT ASSUMED. zod's issue for this case is
    //   `{ code: 'unrecognized_keys', keys: ['isAdmin'], path: [], message: '…' }`:
    //   the offending key is in `keys`, and `path` is EMPTY. `params.fields` is
    //   built from `path`, so there is nothing to put in it.
    //
    //   `keys` is not reachable: `exceptionFactory` is typed against Standard
    //   Schema's `Issue`, which declares only `message` and `path`, so reading it
    //   would be an assertion about one vendor's runtime shape — and the `message`
    //   that does name the key is the English prose critical-rules #8 forbids on a
    //   wire. The refusal is correct and complete; only "which key" is missing, and
    //   it is missing for every Standard Schema validator, not just this one.
    //   Recorded in HANDOVER.md rather than worked around.
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
    // critical-rules #8: an error carries a code, never a sentence. zod's own
    // wording for this failure is "Invalid input: expected string, received
    // object"; a surface cannot translate it and cannot shorten it.
    const served = JSON.stringify(refusal.refusal);
    expect(served).not.toMatch(/invalid input|expected|received/i);
  });

  it('gives the caller a branchable id on the exception itself', async () => {
    const refusal = await refusalFor({ ...body, locale: { a: 1 } });
    // `errorCode` reaches the body only when the exception is built from a STRING
    // message — with an object response it is silently not merged. Needs
    // @nestjs/common >= 12.0.2; this repository is on 12.0.3.
    expect(refusal.errorCode).toBe(ApiErrorCode.SCHEMA_INVALID);
  });
});
