import type { MemorisedResponse } from '@arthome-platform/http-edge';
import { Command } from '@nestjs/cqrs';

import type { DateSheet } from './date-sheet.js';
import type { DraftDateBody } from './draft-date.schema.js';
import type { IdempotentRequest } from '../idempotency/idempotency.js';

/** The studio's `createDateDraft`, for the channel of the path. */
export class DraftDate extends Command<MemorisedResponse<DateSheet>> {
  public constructor(
    public readonly channelId: string,
    public readonly body: DraftDateBody,
    public readonly traceparent: string | null,
    public readonly idempotency: IdempotentRequest,
  ) {
    super();
  }
}
