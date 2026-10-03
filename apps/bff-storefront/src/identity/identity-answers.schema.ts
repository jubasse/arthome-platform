import { z } from 'zod';

import { InstantOut } from '@arthome/core/schema';

/**
 * What identity answers this BFF: shapes between two of this repository's processes, so they live
 *   here and not in `@arthome/contracts` (identity's HANDOVER, "where a schema belongs").
 */

const SessionSchema = z.looseObject({
  accountId: z.uuid(),
  /** The session's id, standing for the device until devices register (auth slice C). */
  deviceId: z.uuid(),
  expiresAt: InstantOut,
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

export const VerificationSentSchema = z.looseObject({
  data: z.looseObject({ sent: z.boolean() }),
});

export const AddressVerifiedSchema = z.looseObject({
  data: z.looseObject({ verified: z.boolean() }),
});
