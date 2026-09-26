import type { DateDocument, IndexedRendition } from '@arthome-platform/search-index';

import type { Rendition } from '@arthome/core';

import type { PublicDate } from '../public/date-card.js';

/** A document `filtersOf` let through: the fields a card requires are present. */
export type ServableDateDocument = DateDocument & {
  readonly publication_state: NonNullable<DateDocument['publication_state']>;
  readonly replay_policy: NonNullable<DateDocument['replay_policy']>;
  readonly rights_scope: NonNullable<DateDocument['rights_scope']>;
};

function renditionOf(indexed: IndexedRendition): Rendition {
  return { url: indexed.url, widthPx: indexed.width_px, heightPx: indexed.height_px };
}

export function publicDateOf(document: ServableDateDocument): PublicDate {
  return {
    ...document,
    media: {
      wide: document.media.wide.map(renditionOf),
      poster: document.media.poster.map(renditionOf),
    },
  };
}
