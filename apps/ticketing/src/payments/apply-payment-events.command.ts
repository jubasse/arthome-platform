import { Command } from '@nestjs/cqrs';

/** One pass over the webhook inbox; answers how many events it applied or gave up on. */
export class ApplyPaymentEvents extends Command<number> {
  public constructor(public readonly batch: number) {
    super();
  }
}
