import type { Provider } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { DateTiming, PublicationState } from '@arthome/core';

import { readDateFacts } from '../entitlement/entitlement-facts.js';

/**
 * What the run desk reads of PS2's projected date: the publication state for `goOnAir` and the
 *   timing for the end by itself. PS2's `DateFacts` carries more and is assignable to it.
 */
export interface RunDateFacts {
  readonly timing: DateTiming | null;
  readonly publicationState: PublicationState | null;
}

/** PS2's `readDateFacts(manager, dateId)`, on the caller's manager, no lock. */
export type ReadDateFacts = (
  manager: EntityManager,
  dateId: string,
) => Promise<RunDateFacts | null>;

/** A token, so a suite projects the dates it names without feeding PS2's consumer. */
export const READ_DATE_FACTS: unique symbol = Symbol('ReadDateFacts');

export const DATE_FACTS_PROVIDER: Provider = {
  provide: READ_DATE_FACTS,
  useValue: readDateFacts satisfies ReadDateFacts,
};
