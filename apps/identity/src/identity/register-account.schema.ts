import { z } from 'zod';

import { CountryCodeSchema, LocaleIn, PublicHandleSchema } from '@arthome/core/schema';

// ⚠ A `locale` of `{"a":1}` once passed every hop: `pg` stored `{"a":1}` while protobuf
//   published `[object Object]`, and the two can never be reconciled.
// ⚠ Not in `@arthome/contracts`: `POST /accounts` is in no OpenAPI document.
export const RegisterAccountSchema = z.strictObject({
  publicHandle: PublicHandleSchema,

  /** Not lower-cased: the column is `citext`, and normalising would change what the welcome email is addressed to. */
  email: z.email(),

  /** Member-strict on the `In` side: `LOCALES` is `['fr','en']`, and a `de` account had no welcome-email template. */
  locale: LocaleIn,

  /** ⚠ Shape-checked only, so `"ZZ"` passes: `@arthome/core` publishes no ISO 3166-1 vocabulary and a list here would go stale. */
  country: CountryCodeSchema,
});

/** An alias, never a class — a class-typed schema param is rejected by a global `ValidationPipe`. */
export type RegisterAccountBody = z.infer<typeof RegisterAccountSchema>;
