import type { Provider } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { DateTiming, PublicationState } from '@arthome/core';

/**
 * What the run desk reads of PS2's projected date: the publication state for `goOnAir` and the
 *   timing for the end by itself. PS2's `DateFacts` carries more and is assignable to it.
 */
export interface RunDateFacts {
  readonly timing: DateTiming | null;
  readonly publicationState: PublicationState | null;
}

/** PS2's declared `readDateFacts(manager, dateId)`, on the caller's manager, no lock. */
export type ReadDateFacts = (
  manager: EntityManager,
  dateId: string,
) => Promise<RunDateFacts | null>;

export const READ_DATE_FACTS: unique symbol = Symbol('ReadDateFacts');

/**
 * Until PS2's projection merges, no date is projected: `goOnAir` is refused and no run ends by
 *   itself, the safe side of both. PS1 merges after PS2 and binds `readDateFacts` here then.
 */
const nothingProjectedYet: ReadDateFacts = () => Promise.resolve(null);

export const DATE_FACTS_PROVIDER: Provider = {
  provide: READ_DATE_FACTS,
  useValue: nothingProjectedYet,
};
