import { PublicationChecklistItem, type Bilingual } from '@arthome/core';

import type { Show } from '../catalog/show.entity.js';

const hasCopy = (text: Bilingual): boolean => text.fr.length > 0 || text.en.length > 0;

/** The checklist items catalog holds itself, read off the show; the others are projected. */
export function ownChecklistFacts(show: Show): PublicationChecklistItem[] {
  const facts: PublicationChecklistItem[] = [];
  if (hasCopy(show.title) && show.category_id.length > 0) {
    facts.push(PublicationChecklistItem.TITLE_AND_DISCIPLINE);
  }
  if (show.media.poster.length > 0) facts.push(PublicationChecklistItem.POSTER);
  if (hasCopy(show.synopsis)) facts.push(PublicationChecklistItem.DESCRIPTION);
  return facts;
}
