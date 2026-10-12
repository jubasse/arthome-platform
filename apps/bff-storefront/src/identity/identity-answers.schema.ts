import { z } from 'zod';

import { InstantOut } from '@arthome/core/schema';

/**
 * What identity answers this BFF: shapes between two of this repository's processes, so they live
 *   here and not in `@arthome/contracts` (identity's HANDOVER, "where a schema belongs").
 */

/** The profile the session watches as; `kind` is `adult` or `child`. */
const ProfileSchema = z.looseObject({
  id: z.uuid(),
  name: z.string(),
  kind: z.string(),
});

export type SessionProfile = z.output<typeof ProfileSchema>;

const SessionSchema = z.looseObject({
  accountId: z.uuid(),
  /** The registered device the session is bound to: the internal token's `did`. */
  deviceId: z.uuid(),
  /** The binding of the session to its device and profile, which `signOutProfile` closes. */
  deviceSessionId: z.uuid(),
  expiresAt: InstantOut,
  profile: ProfileSchema,
});

export type ResolvedSession = z.output<typeof SessionSchema>;

const ViewerSchema = z.looseObject({
  publicHandle: z.string(),
  emailVerified: z.boolean(),
});

export type ViewerAccount = z.output<typeof ViewerSchema>;

export const SessionOpenedSchema = z.looseObject({
  data: z.looseObject({
    session: SessionSchema.extend({ token: z.string().min(1) }),
    account: ViewerSchema,
    /** The browser's device token to set now; null on a replayed sign-up, which re-sets nothing. */
    device: z.looseObject({ token: z.string().min(1).nullable() }),
  }),
});

export type SessionOpened = z.output<typeof SessionOpenedSchema>['data'];

/** A session in use, with what the viewer context shows of its account: one call to identity. */
const ResolvedViewerSchema = SessionSchema.extend({ account: ViewerSchema });

export type ResolvedViewer = z.output<typeof ResolvedViewerSchema>;

export const SessionResolvedSchema = z.looseObject({
  data: z.looseObject({ session: ResolvedViewerSchema.nullable() }),
});

export const SignedOutSchema = z.looseObject({ data: z.looseObject({ signedOut: z.boolean() }) });

export const DeviceRevokedAnswerSchema = z.looseObject({
  data: z.looseObject({ revoked: z.boolean() }),
});

export const DeviceSessionClosedAnswerSchema = z.looseObject({
  data: z.looseObject({ closed: z.boolean() }),
});

export const VerificationQueuedSchema = z.looseObject({
  data: z.looseObject({ queued: z.boolean() }),
});

export const AddressVerifiedSchema = z.looseObject({
  data: z.looseObject({ verified: z.boolean() }),
});
