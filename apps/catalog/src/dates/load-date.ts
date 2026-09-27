import { dateNotFound } from './date-records.js';
import type { PerformanceDate } from './performance-date.aggregate.js';
import { Show } from '../catalog/show.entity.js';
import type { CatalogTransaction } from '../catalog-transactions.js';
import { Venue } from '../venues/venue.entity.js';

export interface LoadedDate {
  readonly date: PerformanceDate;
  /** What the date's consequences copy: its public row, its canonical URL, its venue's clock. */
  readonly show: Show;
  readonly venue: Venue;
}

/** A missing date is 404. */
export async function loadDate(
  { manager, dates }: CatalogTransaction,
  dateId: string,
): Promise<LoadedDate> {
  const date = await dates.findById(dateId);
  if (date === null) throw dateNotFound();
  const { showId, venueId } = date.snapshot;
  return {
    date,
    show: await manager.findOneByOrFail(Show, { id: showId }),
    venue: await manager.findOneByOrFail(Venue, { id: venueId }),
  };
}
