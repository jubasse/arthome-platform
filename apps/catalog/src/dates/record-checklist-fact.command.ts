import type { Outcome } from '@arthome-platform/messaging';
import { Command } from '@nestjs/cqrs';

import type { PublicationChecklistItem } from '@arthome/core';

/** A checklist item as another context reported it (data-model.md §2.3). */
export interface ChecklistFact {
  readonly dateId: string;
  readonly item: PublicationChecklistItem;
  readonly satisfied: boolean;
  readonly occurredAt: Date;
}

/** Dispatched by the checklist consumer, once per message it reads as a fact. */
export class RecordChecklistFact extends Command<Outcome> {
  public constructor(
    public readonly messageId: string,
    public readonly topic: string,
    public readonly fact: ChecklistFact,
  ) {
    super();
  }
}
