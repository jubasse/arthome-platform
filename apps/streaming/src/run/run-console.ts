import type { HandlerOutput } from '@arthome/contracts/http';
import type { streamingServiceApi } from '@arthome/contracts/streaming-service-api';

import type { IncidentSnapshot } from './incident.js';
import type { RunSnapshot } from './run.aggregate.js';
import type { FeedSample, LiveIngestProvider } from '../media/media-ports.js';

type Routes = (typeof streamingServiceApi)['routes'];

export type RunConsole = HandlerOutput<Routes['getRunConsole']>['data'];
export type StudioIncident = HandlerOutput<Routes['raiseIncident']>['data'];
export type TechnicalCheckAnswer = HandlerOutput<Routes['runTechnicalCheck']>['data'];
export type IncidentResolution = HandlerOutput<Routes['resolveIncident']>['data'];
export type HealthSample = NonNullable<TechnicalCheckAnswer['sample']>;

/** A server-side observation of the ingest, never the encoder's own figure. */
const INGEST_SERVER = 'ingest_server';

export function studioIncidentOf(incident: IncidentSnapshot): NonNullable<StudioIncident> {
  return {
    id: incident.id,
    kind: incident.kind,
    cause: incident.cause,
    trigger: incident.trigger,
    ...(incident.message !== null && { message: incident.message }),
    raisedAt: incident.raisedAt,
  };
}

export function healthSampleOf(sample: FeedSample): HealthSample {
  return {
    measuredAt: sample.measuredAt,
    source: INGEST_SERVER,
    ingestUpKbps: sample.ingestUpKbps,
    ...(sample.jitterMs !== undefined && { jitterMs: sample.jitterMs }),
    ...(sample.lostPackets !== undefined && { lostPackets: sample.lostPackets }),
  };
}

/**
 * The console in one call. `lastSample` only where it was measured: absent, never a flat zero.
 *   The stream key is never part of it (`data-model.md` §5.2).
 */
export function runConsoleOf(
  run: RunSnapshot,
  openIncident: IncidentSnapshot | null,
  ingest: LiveIngestProvider,
  sample: FeedSample | null = null,
): RunConsole {
  return {
    dateId: run.dateId,
    state: run.state,
    afterGracePeriod: run.afterGracePeriod,
    ingestProtocol: run.ingestProtocol,
    monitorPath: run.monitorPath,
    monitorUrl: ingest.monitorUrlFor(run.monitorPath, run.streamPath),
    startedAt: run.startedAt,
    ...(sample !== null && { lastSample: healthSampleOf(sample) }),
    incident: openIncident === null ? null : studioIncidentOf(openIncident),
    version: run.version,
  };
}
