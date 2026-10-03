import { describe, expect, it } from 'vitest';

import { SignInSchema, SignUpSchema, TokenSchema } from './sign-up.schema.js';

const SIGN_UP = {
  email: 'marie@example.test',
  password: 'a-long-password',
  locale: 'fr',
  country: 'FR',
  acceptedTermsVersion: 3,
};

describe('the BFF’s sign-up call', () => {
  it('takes the contract’s fields and the country the BFF resolved, the unknown region included', () => {
    expect(SignUpSchema.safeParse(SIGN_UP).success).toBe(true);
    expect(
      SignUpSchema.safeParse({ ...SIGN_UP, country: 'ZZ', displayName: 'Marie' }).success,
    ).toBe(true);
  });

  it('refuses a password outside twelve to 128 characters', () => {
    expect(SignUpSchema.safeParse({ ...SIGN_UP, password: 'eleven-char' }).success).toBe(false);
    expect(SignUpSchema.safeParse({ ...SIGN_UP, password: 'x'.repeat(129) }).success).toBe(false);
  });

  it('refuses a locale it cannot write an email in, a missing terms version, a key it does not know', () => {
    expect(SignUpSchema.safeParse({ ...SIGN_UP, locale: 'de' }).success).toBe(false);
    const { acceptedTermsVersion: _omitted, ...withoutTerms } = SIGN_UP;
    expect(SignUpSchema.safeParse(withoutTerms).success).toBe(false);
    expect(SignUpSchema.safeParse({ ...SIGN_UP, publicHandle: '@marie' }).success).toBe(false);
  });
});

describe('sign-in and the tokens carried in a body', () => {
  it('caps a password, so a megabyte is refused before anything hashes it', () => {
    expect(
      SignInSchema.safeParse({ email: SIGN_UP.email, password: 'x'.repeat(129) }).success,
    ).toBe(false);
  });

  it('refuses an empty or oversized token', () => {
    expect(TokenSchema.safeParse({ token: '' }).success).toBe(false);
    expect(TokenSchema.safeParse({ token: 'x'.repeat(513) }).success).toBe(false);
  });
});
