import type { IdempotentRequest, MemorisedResponse } from '@arthome-platform/http-edge';
import { Command } from '@nestjs/cqrs';

import type { WaitlistRegistrationView } from './waitlist-registration.js';

export class JoinWaitlist extends Command<MemorisedResponse<WaitlistRegistrationView>> {
  public constructor(
    public readonly dateId: string,
    public readonly accountId: string,
    public readonly traceparent: string | null,
    public readonly idempotency: IdempotentRequest,
  ) {
    super();
  }
}
