import { Command } from '@nestjs/cqrs';

/** One pass over the refunds still owed; answers how many it asked for. */
export class RefundOwedPayments extends Command<number> {
  public constructor(public readonly batch: number) {
    super();
  }
}
