import { MoreThan, type EntityManager } from 'typeorm';

import { DomainConstant, type Instant } from '@arthome/core';

import type { LinkKind } from './resolve-query.schema.js';
import { SlugAlias } from './slug-alias.entity.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shows and artists share one namespace each; a date's slug is unique within its show. */
export const UNSCOPED = '';

export interface SlugKey {
  readonly kind: LinkKind;
  /** The show's id for a date, `UNSCOPED` for a show or an artist. */
  readonly scope: string;
  readonly slug: string;
}

/** Keeps `key` resolving to `targetId` for `SLUG_REDIRECT_DAYS` from `now` (D-075). */
export async function retireSlug(
  manager: EntityManager,
  key: SlugKey,
  targetId: string,
  now: Instant,
): Promise<void> {
  const expiresAt = new Date(Date.parse(now) + DomainConstant.SLUG_REDIRECT_DAYS * DAY_MS);
  await manager.upsert(SlugAlias, { ...key, target_id: targetId, expires_at: expiresAt }, [
    'kind',
    'scope',
    'slug',
  ]);
}

/** The page a retired slug still points at, null once it expired or when none held it. */
export async function aliasTargetOf(
  manager: EntityManager,
  key: SlugKey,
  now: Instant,
): Promise<string | null> {
  const alias = await manager.findOneBy(SlugAlias, { ...key, expires_at: MoreThan(new Date(now)) });
  return alias?.target_id ?? null;
}

/**
 * A retired slug not yet expired stays with the page it left: giving it to another would send its
 *   old links elsewhere. The page itself may take it back.
 */
export async function reservedForAnother(
  manager: EntityManager,
  key: SlugKey,
  claimantId: string,
  now: Instant,
): Promise<boolean> {
  const target = await aliasTargetOf(manager, key, now);
  return target !== null && target !== claimantId;
}
