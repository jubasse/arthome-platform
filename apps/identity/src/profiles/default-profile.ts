import type { EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { ProfileKind } from './profile-kind.js';

export interface ProfileSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: ProfileKind;
}

/**
 * The account's default profile, created when missing: named `name`, else after the public handle.
 *   Two callers racing both get the one row the partial unique index lets through.
 */
export async function defaultProfileOf(
  manager: EntityManager,
  accountId: string,
  name?: string,
): Promise<ProfileSummary> {
  await manager.query(
    `INSERT INTO profile (id, account_id, name, kind, is_default)
     SELECT $1, a.id, COALESCE($3, a.public_handle::text), $4, true
       FROM account a
      WHERE a.id = $2
     ON CONFLICT (account_id) WHERE is_default DO NOTHING`,
    [uuidv7(), accountId, name ?? null, ProfileKind.ADULT],
  );
  const [profile] = await manager.query<ProfileSummary[]>(
    'SELECT id, name, kind FROM profile WHERE account_id = $1 AND is_default',
    [accountId],
  );
  if (profile === undefined) throw new Error(`account ${accountId} has no default profile`);
  return profile;
}
