import { Command } from '@nestjs/cqrs';

/** One pass over the intents owed a cancellation; answers how many it asked for. */
export class CancelOwedIntents extends Command<number> {
  public constructor(public readonly batch: number) {
    super();
  }
}
