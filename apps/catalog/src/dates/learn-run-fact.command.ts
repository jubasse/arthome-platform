import type { Outcome } from '@arthome-platform/messaging';
import { Command } from '@nestjs/cqrs';

import type { RunState } from '@arthome/core';

export interface RunFact {
  readonly dateId: string;
  /** The run's state as the message says it: on air for a start, ended for an end. */
  readonly run: typeof RunState.ON_AIR | typeof RunState.ENDED;
}

/** Dispatched by the run consumer, once per run message it reads as a fact. */
export class LearnRunFact extends Command<Outcome> {
  public constructor(
    public readonly messageId: string,
    public readonly topic: string,
    public readonly fact: RunFact,
    public readonly traceparent: string | null,
  ) {
    super();
  }
}
