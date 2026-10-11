import type { IEvent } from '@nestjs/cqrs';

import type { IncidentCause, Instant, RunState, Surface } from '@arthome/core';

import type { IncidentSnapshot } from './incident.js';
import type { IngestProtocol, MonitorPath } from '../media/media-ports.js';

/** Who acted: the principal's user on a studio surface, or the system with no account. */
export interface RunActor {
  readonly accountId: string | null;
  readonly surface: Surface;
}

export class RunPrepared implements IEvent {
  public readonly kind = 'RunPrepared';

  public constructor(
    public readonly dateId: string,
    public readonly occurredAt: Instant,
  ) {}
}

export class TechnicalCheckPassed implements IEvent {
  public readonly kind = 'TechnicalCheckPassed';

  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly protocol: IngestProtocol,
    public readonly checkedBy: RunActor,
    public readonly occurredAt: Instant,
  ) {}
}

export class RunStarted implements IEvent {
  public readonly kind = 'RunStarted';

  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly protocol: IngestProtocol,
    public readonly monitorPath: MonitorPath,
    public readonly startedBy: RunActor,
    public readonly occurredAt: Instant,
  ) {}
}

export class RunEnded implements IEvent {
  public readonly kind = 'RunEnded';

  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    /** The live's real end, which may precede the act: the last publisher's loss (D-123). */
    public readonly endedAt: Instant,
    public readonly durationSec: number,
    public readonly endedBy: RunActor,
    public readonly occurredAt: Instant,
  ) {}
}

export class RunStateChanged implements IEvent {
  public readonly kind = 'RunStateChanged';

  public constructor(
    public readonly dateId: string,
    public readonly state: RunState,
    /** The open incident's, on `interrupted` only. */
    public readonly cause: IncidentCause | null,
    public readonly afterGracePeriod: boolean,
    public readonly occurredAt: Instant,
  ) {}
}

export class IncidentRaised implements IEvent {
  public readonly kind = 'IncidentRaised';

  public constructor(
    public readonly dateId: string,
    public readonly channelId: string,
    public readonly incident: IncidentSnapshot,
    public readonly raisedBy: RunActor,
    public readonly occurredAt: Instant,
  ) {}
}

export class IncidentResolved implements IEvent {
  public readonly kind = 'IncidentResolved';

  public constructor(
    public readonly dateId: string,
    public readonly incidentId: string,
    public readonly resolvedBy: RunActor,
    public readonly occurredAt: Instant,
  ) {}
}

/**
 * Every event of the aggregate. A mapping switches on `kind` and ends in `assertNever`, so an event
 *   without its case fails to compile rather than reach the wire as another.
 */
export type RunEvent =
  | RunPrepared
  | TechnicalCheckPassed
  | RunStarted
  | RunEnded
  | RunStateChanged
  | IncidentRaised
  | IncidentResolved;
