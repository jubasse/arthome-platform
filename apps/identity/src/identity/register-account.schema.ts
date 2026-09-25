import { z } from 'zod';

import { CountryCodeSchema, LocaleIn, PublicHandleSchema } from '@arthome/core/schema';

/**
 * ⚠ IT EXISTS BECAUSE `"locale": {"a":1}` WAS COMMITTED AND PUBLISHED AS TWO
 *   DIFFERENT VALUES, with no error at any hop. `pg`'s `prepareValue`
 *   (utils.js:45-70) sends an object through `JSON.stringify`, so `locale text` held
 *   `{"a":1}`; protobuf's writer coerces with `String(value)`
 *   (binary-encoding.js:241-245), so the event carried `[object Object]` — and that
 *   is what `notifications.welcome_email` received. The two cannot be reconciled
 *   afterwards.
 *
 * ⚠ IT STAYS HERE AND NOT IN `@arthome/contracts`. That package is what the
 *   FRONTENDS consume; `POST /accounts` is a BFF-to-service endpoint in no OpenAPI
 *   document. See HANDOVER.md — the obvious "DTOs live in contracts" move is wrong.
 */
export const RegisterAccountSchema = z.strictObject({
  publicHandle: PublicHandleSchema,

  /** Not lower-cased: the column is `citext`, and normalising would change what the welcome email is addressed to. */
  email: z.email(),

  /**
   * ⚠ MEMBER-STRICT, CORRECT ON THE `In` SIDE ONLY. critical-rules #10's tolerance is
   *   the `Out` rule, for a television on a year-old build; `vocabulary.ts` states the
   *   mirror — "tolerance on a read degrades a card; tolerance on a write corrupts a
   *   record". Behaviour change: `LOCALES` is `['fr','en']`, so `"de"` was accepted
   *   before and is refused now. A `de` account had no welcome-email template.
   */
  locale: LocaleIn,

  /**
   * ⚠ SHAPE-STRICT, AND THE ASYMMETRY WITH `locale` IS DELIBERATE. `/^[A-Z]{2}$/`
   *   refuses `{"a":1}`, `"FRA"` and `"fr"`, and accepts `"ZZ"`. ISO 3166-1 has ~250
   *   members and moves, and `@arthome/core` publishes no vocabulary for it, so a list
   *   here would be a parallel table going stale. `locale` can be member-strict
   *   because its vocabulary has two members and this package owns them.
   */
  country: CountryCodeSchema,
});

/** An alias, never a class — a class-typed schema param is rejected by a global `ValidationPipe`. */
export type RegisterAccountBody = z.infer<typeof RegisterAccountSchema>;
