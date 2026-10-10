// Aliased because `@arthome-platform/events` is a flat barrel: a wire enum and core's
// vocabulary share each name, and they are a number and a string.
import {
  IncidentCause as WireIncidentCause,
  IncidentKind as WireIncidentKind,
  IncidentTrigger as WireIncidentTrigger,
  IngestProtocol as WireIngestProtocol,
  MonitorPath as WireMonitorPath,
  RunState as WireRunState,
  Surface as WireSurface,
} from '@arthome-platform/events';

import { IncidentCause, IncidentKind, IncidentTrigger, RunState, Surface } from '@arthome/core';

import { IngestProtocol, MonitorPath } from '../media/media-ports.js';

/**
 * The domain's members → the wire's numbers. `satisfies` points at the domain: a new member in
 *   core fails this build, and the proto's `UNSPECIFIED = 0` rightly has no domain member.
 */
const WIRE_RUN_STATE = {
  [RunState.IDLE]: WireRunState.IDLE,
  [RunState.REHEARSAL]: WireRunState.REHEARSAL,
  [RunState.ON_AIR]: WireRunState.ON_AIR,
  [RunState.INTERRUPTED]: WireRunState.INTERRUPTED,
  [RunState.ENDED]: WireRunState.ENDED,
} satisfies Record<RunState, WireRunState>;

const WIRE_INCIDENT_KIND = {
  [IncidentKind.HOLD_SCREEN]: WireIncidentKind.HOLD_SCREEN,
  [IncidentKind.POSTPONED]: WireIncidentKind.POSTPONED,
  [IncidentKind.CANCELLED]: WireIncidentKind.CANCELLED,
  [IncidentKind.INTERRUPTED]: WireIncidentKind.INTERRUPTED,
} satisfies Record<IncidentKind, WireIncidentKind>;

const WIRE_INCIDENT_CAUSE = {
  [IncidentCause.VENUE_FEED_LOST]: WireIncidentCause.VENUE_FEED_LOST,
  [IncidentCause.RUN_DESK_DISCONNECTED]: WireIncidentCause.RUN_DESK_DISCONNECTED,
  [IncidentCause.BITRATE_COLLAPSED]: WireIncidentCause.BITRATE_COLLAPSED,
  [IncidentCause.COMPATIBILITY_WORKER_FAILED]: WireIncidentCause.COMPATIBILITY_WORKER_FAILED,
  [IncidentCause.PROVIDER_ERROR]: WireIncidentCause.PROVIDER_ERROR,
  [IncidentCause.MANUAL]: WireIncidentCause.MANUAL,
} satisfies Record<IncidentCause, WireIncidentCause>;

const WIRE_INCIDENT_TRIGGER = {
  [IncidentTrigger.MANUAL]: WireIncidentTrigger.MANUAL,
  [IncidentTrigger.AUTO]: WireIncidentTrigger.AUTO,
} satisfies Record<IncidentTrigger, WireIncidentTrigger>;

const WIRE_INGEST_PROTOCOL = {
  [IngestProtocol.RTMPS]: WireIngestProtocol.RTMPS,
  [IngestProtocol.SRT]: WireIngestProtocol.SRT,
  [IngestProtocol.WHIP]: WireIngestProtocol.WHIP,
} satisfies Record<IngestProtocol, WireIngestProtocol>;

const WIRE_MONITOR_PATH = {
  [MonitorPath.WHEP]: WireMonitorPath.WHEP,
  [MonitorPath.LL_HLS]: WireMonitorPath.LL_HLS,
} satisfies Record<MonitorPath, WireMonitorPath>;

const WIRE_SURFACE = {
  [Surface.STOREFRONT_WEB]: WireSurface.STOREFRONT_WEB,
  [Surface.STOREFRONT_MOBILE]: WireSurface.STOREFRONT_MOBILE,
  [Surface.STOREFRONT_TV]: WireSurface.STOREFRONT_TV,
  [Surface.STUDIO_WEB]: WireSurface.STUDIO_WEB,
  [Surface.STUDIO_MOBILE]: WireSurface.STUDIO_MOBILE,
  [Surface.SYSTEM]: WireSurface.SYSTEM,
} satisfies Record<Surface, WireSurface>;

/**
 * Each mapping answers `UNSPECIFIED` for a member this build does not know, kept raw on the row:
 *   neutral on the wire, never refused (critical rule 10).
 */
function wireOf<K extends string, W extends number>(
  table: Readonly<Record<K, W>>,
  member: string,
): W | 0 {
  return Object.hasOwn(table, member) ? table[member as K] : 0;
}

export const wireRunState = (state: string): WireRunState => wireOf(WIRE_RUN_STATE, state);

export const wireIncidentKind = (kind: string): WireIncidentKind =>
  wireOf(WIRE_INCIDENT_KIND, kind);

export const wireIncidentCause = (cause: string): WireIncidentCause =>
  wireOf(WIRE_INCIDENT_CAUSE, cause);

export const wireIncidentTrigger = (trigger: string): WireIncidentTrigger =>
  wireOf(WIRE_INCIDENT_TRIGGER, trigger);

export const wireIngestProtocol = (protocol: string): WireIngestProtocol =>
  wireOf(WIRE_INGEST_PROTOCOL, protocol);

export const wireMonitorPath = (path: string): WireMonitorPath => wireOf(WIRE_MONITOR_PATH, path);

export const wireSurface = (surface: string): WireSurface => wireOf(WIRE_SURFACE, surface);
