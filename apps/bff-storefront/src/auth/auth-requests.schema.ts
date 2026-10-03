import { z } from 'zod';

import { SESSION_MODES } from '@arthome/contracts/identity';
import { LocaleIn } from '@arthome/core/schema';

/**
 * The contract's request bodies (storefront.yaml), which `@arthome/contracts` does not emit. Plain
 *   objects: a field the contract does not name is dropped, never relayed.
 */

/** storefront.yaml publishes both bounds; identity enforces the same ones. */
const NewPassword = z.string().min(12).max(128);

/** Ignored until devices register (auth slice C): an asserted id proves nothing. */
const AssertedDeviceId = z.uuid().nullable().optional();

export const SignUpRequestSchema = z.object({
  email: z.email(),
  password: NewPassword,
  displayName: z.string().max(80).optional(),
  mode: z.enum(SESSION_MODES),
  deviceId: AssertedDeviceId,
  acceptedTermsVersion: z.number().int().min(1),
  locale: LocaleIn,
});

export type SignUpRequest = z.infer<typeof SignUpRequestSchema>;

export const SignInRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(128),
  mode: z.enum(SESSION_MODES),
  deviceId: AssertedDeviceId,
});

export type SignInRequest = z.infer<typeof SignInRequestSchema>;

export const VerificationLinkSchema = z.object({ token: z.string().min(1).max(256) });

export type VerificationLink = z.infer<typeof VerificationLinkSchema>;
