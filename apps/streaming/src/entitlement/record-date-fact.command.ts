import type { Outcome } from '@arthome-platform/messaging';
import { Command } from '@nestjs/cqrs';

import type {
  BlackoutReason,
  DateOutcome,
  PublicationState,
  ReplayPolicy,
  RightsScope,
} from '@arthome/core';

import type { Delivery } from '../delivery.js';

export interface ReplayFacts {
  readonly policy: ReplayPolicy;
  readonly windowHours: number;
}

/** `scope` null when this build does not know it, which refuses; `reason` null alone keeps the countries out. */
export interface RightsFacts {
  readonly scope: RightsScope | null;
  readonly blackoutCountries: readonly string[];
  readonly reason: BlackoutReason | null;
}

/** What catalog says about a date, each fact stated at the instant its group is guarded by. */
export type DateFact =
  | {
      readonly type: 'catalog.date.scheduled.v1';
      readonly dateId: string;
      readonly channelId: string;
      readonly startsAt: Date;
      readonly runtimeMin: number;
      readonly replay: ReplayFacts;
      readonly rights: RightsFacts;
      readonly statedAt: Date;
    }
  | {
      readonly type: 'catalog.date.rescheduled.v1';
      readonly dateId: string;
      readonly startsAt: Date;
      readonly statedAt: Date;
    }
  | {
      readonly type: 'catalog.date.replay_policy_set.v1';
      readonly dateId: string;
      readonly replay: ReplayFacts;
      readonly statedAt: Date;
    }
  | {
      readonly type: 'catalog.date.rights_changed.v1';
      readonly dateId: string;
      readonly rights: RightsFacts;
      readonly statedAt: Date;
    }
  | {
      readonly type: 'catalog.publication.state_changed.v1';
      readonly dateId: string;
      readonly channelId: string;
      readonly state: PublicationState | null;
      /** Catalog's version after the transition: the publication's guard, not `statedAt`. */
      readonly version: bigint;
      readonly statedAt: Date;
    }
  | {
      readonly type: 'catalog.date.outcome_declared.v1';
      readonly dateId: string;
      readonly channelId: string;
      readonly outcome: DateOutcome;
      /** Its `declared_at`. */
      readonly statedAt: Date;
    };

export class RecordDateFact extends Command<Outcome> {
  public constructor(
    public readonly delivery: Delivery,
    public readonly fact: DateFact,
  ) {
    super();
  }
}
