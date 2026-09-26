import { CatalogErrorCode, DomainErrorCode } from '@arthome/core';

// Every uniquely-constrained column a caller can collide on must appear here: one that does not
// answers 500. The date slugs are absent on purpose: `freeSlug` picks a free one first.
export const UNIQUE_VIOLATION_CODES = [
  { column: 'artist_slug', code: CatalogErrorCode.ARTIST_SLUG_TAKEN },
  // Two first edits of one channel's face racing: the loser read version 0 and lost.
  { column: 'artist_channel_id', code: DomainErrorCode.STATE_CONFLICT },
] as const;
