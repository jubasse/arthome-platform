import { CatalogErrorCode, DomainErrorCode } from '@arthome/core';

// Every uniquely-constrained column a caller can collide on must appear here: one that does not
// answers 500. The filter matches a column inside the constraint's name, so `show_slug` also
// answers `date_show_slug`, which no command reaches: each picks a date's slug under its show's
// row lock (`loadDate`).
export const UNIQUE_VIOLATION_CODES = [
  { column: 'artist_slug', code: CatalogErrorCode.ARTIST_SLUG_TAKEN },
  // Two first edits of one channel's face racing: the loser read version 0 and lost.
  { column: 'artist_channel_id', code: DomainErrorCode.STATE_CONFLICT },
  // Two shows of one title published at once: no row to lock, so the loser retries and takes
  // the next free slug.
  { column: 'show_slug', code: DomainErrorCode.STATE_CONFLICT },
] as const;
