import type { MemorisedResponse } from '@arthome-platform/http-edge';
import { Command } from '@nestjs/cqrs';

import type { PublicationView } from './date-sheet.js';
import type { TransitionPublicationBody } from './transition-publication.schema.js';
import type { IdempotentRequest } from '../idempotency/idempotency.js';

/** The studio's `moveDatePublicationState`. */
export class TransitionPublication extends Command<MemorisedResponse<PublicationView>> {
  public constructor(
    public readonly dateId: string,
    public readonly body: TransitionPublicationBody,
    public readonly traceparent: string | null,
    public readonly idempotency: IdempotentRequest,
  ) {
    super();
  }
}
