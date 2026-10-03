import { z } from 'zod';

import { CountryCodeSchema, LocaleIn } from '@arthome/core/schema';

import { PASSWORD_LENGTH } from './better-auth.js';

/** The BFF's call, not the contract's `signUp`: the BFF has resolved the country by then. */
export const SignUpSchema = z.strictObject({
  /** Not lower-cased here: the column is `citext`, and the welcome email goes to what was typed. */
  email: z.email(),
  password: z.string().min(PASSWORD_LENGTH.min).max(PASSWORD_LENGTH.max),
  displayName: z.string().max(80).optional(),
  locale: LocaleIn,
  /** Shape-checked only: `ZZ`, the unknown region, when the edge could not place the visitor. */
  country: CountryCodeSchema,
  acceptedTermsVersion: z.number().int().min(1),
});

export type SignUpBody = z.infer<typeof SignUpSchema>;

export const SignInSchema = z.strictObject({
  email: z.email(),
  password: z.string().min(1).max(PASSWORD_LENGTH.max),
});

export type SignInBody = z.infer<typeof SignInSchema>;

/** A session token, or a verification token, carried in a body rather than a header. */
export const TokenSchema = z.strictObject({ token: z.string().min(1).max(512) });

export type TokenBody = z.infer<typeof TokenSchema>;
