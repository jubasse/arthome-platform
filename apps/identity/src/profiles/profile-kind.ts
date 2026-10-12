/** `data-model.md` §1.2. Core names no vocabulary for it yet; the BFF reads it as a string. */
export const PROFILE_KINDS = ['adult', 'child'] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

export const ProfileKind = {
  ADULT: 'adult',
  CHILD: 'child',
} as const satisfies Record<string, ProfileKind>;
