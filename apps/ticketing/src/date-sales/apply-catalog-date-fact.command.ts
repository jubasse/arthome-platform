import type { Outcome } from '@arthome-platform/messaging';
import { Command } from '@nestjs/cqrs';

import type { DateOutcome, Instant } from '@arthome/core';

/** What ticketing takes from `arthome.catalog.date`, each fact stated at its `occurred_at`. */
export type CatalogDateFact =
  | {
      readonly kind: 'drafted';
      readonly dateId: string;
      readonly channelId: string;
      readonly statedAt: Instant;
    }
  | { readonly kind: 'lock'; readonly dateId: string; readonly statedAt: Instant }
  | {
      /** Scheduled at publication, or moved by a postponement. */
      readonly kind: 'start';
      readonly dateId: string;
      readonly startsAt: Instant;
      readonly statedAt: Instant;
    }
  | {
      readonly kind: 'outcome';
      readonly dateId: string;
      readonly outcome: DateOutcome;
      readonly statedAt: Instant;
    };

/** Dispatched by the consumer, once per message it reads as a fact. */
export class ApplyCatalogDateFact extends Command<Outcome> {
  public constructor(
    public readonly messageId: string,
    public readonly topic: string,
    public readonly traceparent: string | null,
    public readonly fact: CatalogDateFact,
  ) {
    super();
  }
}
