import type { IdempotentRequest, MemorisedResponse } from '@arthome-platform/http-edge';
import { Command } from '@nestjs/cqrs';

import type { RunState } from '@arthome/core';

import type { RaisedIncident } from './incident.js';
import type {
  IncidentResolution,
  RunConsole,
  StudioIncident,
  TechnicalCheckAnswer,
} from './run-console.js';
import type { RunActor } from './run.events.js';

/** What every run desk command carries from its route: who, the key it replays under, the trace. */
export interface RunDeskCall {
  readonly actor: RunActor;
  readonly idempotency: IdempotentRequest;
  readonly traceparent: string | null;
}

/** The states a studio command asks for; `interrupted` is reached through an incident alone. */
export type RunMoveTarget =
  typeof RunState.IDLE | typeof RunState.REHEARSAL | typeof RunState.ON_AIR | typeof RunState.ENDED;

export class MoveRun extends Command<MemorisedResponse<RunConsole>> {
  public constructor(
    public readonly dateId: string,
    public readonly to: RunMoveTarget,
    public readonly expectedVersion: number,
    public readonly call: RunDeskCall,
  ) {
    super();
  }
}

export class CheckRun extends Command<MemorisedResponse<TechnicalCheckAnswer>> {
  public constructor(
    public readonly dateId: string,
    public readonly call: RunDeskCall,
  ) {
    super();
  }
}

export class RaiseIncident extends Command<MemorisedResponse<NonNullable<StudioIncident>>> {
  public constructor(
    public readonly dateId: string,
    public readonly incident: RaisedIncident,
    public readonly call: RunDeskCall,
  ) {
    super();
  }
}

export class ResolveIncident extends Command<MemorisedResponse<NonNullable<IncidentResolution>>> {
  public constructor(
    public readonly incidentId: string,
    public readonly call: RunDeskCall,
  ) {
    super();
  }
}
