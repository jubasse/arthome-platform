import { Command } from '@nestjs/cqrs';

export const PRIORITY_WINDOW_END_BATCH = 100;

/** One pass of the windows' end; answers how many windows it ended. */
export class EndPriorityWindows extends Command<number> {
  public constructor(public readonly batch: number = PRIORITY_WINDOW_END_BATCH) {
    super();
  }
}
