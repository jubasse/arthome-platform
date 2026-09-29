import { Command } from '@nestjs/cqrs';

export interface PaymentEventReceipt {
  readonly eventId: string;
  /** Already recorded: the provider delivered it again. */
  readonly duplicate: boolean;
}

/** A provider's webhook as received: its exact bytes, before anything parses them. */
export class RecordPaymentEvent extends Command<PaymentEventReceipt> {
  public constructor(
    public readonly rawBody: Buffer,
    public readonly signature: string | undefined,
    public readonly traceparent: string | null,
  ) {
    super();
  }
}
