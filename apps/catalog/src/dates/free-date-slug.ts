import { Not, type EntityManager } from 'typeorm';

import type { Instant } from '@arthome/core';

import { PerformanceDateRow } from './performance-date.entity.js';
import { dateSlugCandidates } from './slug.js';
import { LinkKind } from '../public/resolve-query.schema.js';
import { reservedForAnother } from '../public/slug-aliases.js';

/**
 * The first slug for `startsAt` no other date of the show holds or still reserves (D-075). The
 *   last candidate carries the date's own id; the unique index settles a race.
 */
export async function freeDateSlug(
  manager: EntityManager,
  date: { readonly id: string; readonly show_id: string },
  startsAt: Instant,
  timeZone: string,
  now: Instant,
): Promise<string> {
  const candidates = dateSlugCandidates(startsAt, timeZone, date.id);
  for (const candidate of candidates) {
    const held = await manager.existsBy(PerformanceDateRow, {
      show_id: date.show_id,
      slug: candidate,
      id: Not(date.id),
    });
    const key = { kind: LinkKind.DATE, scope: date.show_id, slug: candidate };
    if (!held && !(await reservedForAnother(manager, key, date.id, now))) {
      return candidate;
    }
  }
  return candidates[candidates.length - 1] ?? date.id;
}
