import type { IdempotentRequest, MemorisedResponse } from '@arthome-platform/http-edge';
import { Command } from '@nestjs/cqrs';

/** storefront.yaml's `WaitlistDeparture`: left, or never on the list, alike. */
export interface WaitlistDepartureView {
  readonly joined: false;
}

export class LeaveWaitlist extends Command<MemorisedResponse<WaitlistDepartureView>> {
  public constructor(
    public readonly dateId: string,
    public readonly accountId: string,
    public readonly traceparent: string | null,
    public readonly idempotency: IdempotentRequest,
  ) {
    super();
  }
}
