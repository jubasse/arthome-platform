import { notFound } from '@arthome-platform/http-edge';
import type { EntityManager } from 'typeorm';

import type { DateRecords } from './date-sheet.js';
import { PerformanceDateRow } from './performance-date.entity.js';
import {
  performanceDateSnapshotOf,
  publicationSnapshotOf,
} from './performance-date.typeorm-repository.js';
import { PublicationChecklistFact } from './publication-checklist-fact.entity.js';
import { PublicationRow } from './publication.entity.js';
import { Show } from '../catalog/show.entity.js';
import { Venue } from '../venues/venue.entity.js';

export async function dateRecordsOf(manager: EntityManager, dateId: string): Promise<DateRecords> {
  const date = await manager.findOneBy(PerformanceDateRow, { id: dateId });
  if (date === null) throw notFound();
  return {
    date: performanceDateSnapshotOf(date),
    publication: publicationSnapshotOf(
      await manager.findOneByOrFail(PublicationRow, { date_id: dateId }),
    ),
    show: await manager.findOneByOrFail(Show, { id: date.show_id }),
    venue: await manager.findOneByOrFail(Venue, { id: date.venue_id }),
    projectedFacts: await manager.findBy(PublicationChecklistFact, { date_id: dateId }),
  };
}
