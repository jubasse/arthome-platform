import type { IdempotentRequest, MemorisedResponse } from '@arthome-platform/http-edge';
import { Command } from '@nestjs/cqrs';

import type { DateOutcome, Instant } from '@arthome/core';

import type { DeclareOutcomeBody } from './declare-outcome.schema.js';

export interface DeclaredOutcome {
  readonly outcome: DateOutcome;
  readonly declaredAt: Instant;
}

/** The studio's `decideDateOutcome`, `expectedVersion` being the publication's. */
export class DeclareOutcome extends Command<MemorisedResponse<DeclaredOutcome>> {
  public constructor(
    public readonly dateId: string,
    public readonly body: DeclareOutcomeBody,
    public readonly traceparent: string | null,
    public readonly idempotency: IdempotentRequest,
  ) {
    super();
  }
}
