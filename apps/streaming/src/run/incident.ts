import type { IncidentCause, IncidentKind, IncidentTrigger, Instant } from '@arthome/core';

/** Content written by the run desk, in the language it was written in: never an i18n key. */
export interface IncidentMessage {
  readonly contentLanguage: string;
  readonly text: string;
}

export interface IncidentSnapshot {
  readonly id: string;
  readonly kind: IncidentKind;
  readonly cause: IncidentCause;
  readonly trigger: IncidentTrigger;
  readonly message: IncidentMessage | null;
  readonly raisedAt: Instant;
  /** Null for the system, as `resolvedBy`. */
  readonly raisedBy: string | null;
  readonly resolvedAt: Instant | null;
  readonly resolvedBy: string | null;
}

export type RaisedIncident = Pick<IncidentSnapshot, 'id' | 'kind' | 'cause' | 'message'>;
