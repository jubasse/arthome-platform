import { randomUUID } from 'node:crypto';

import { IncidentRaisedSchema, RunStateChangedSchema } from '@arthome-platform/events';
import { guardDeclaredResponses } from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { streamingServiceApi } from '@arthome/contracts/streaming-service-api';
import { DomainErrorCode, IncidentCause, IncidentKind, Locale, RunState } from '@arthome/core';

import { readRunFacts } from './run-facts.js';
import {
  CASE_MS,
  STARTUP_MS,
  feedOn,
  outboxOf,
  preparedRun,
  startRunDesk,
  stopRunDesk,
  studioCall,
  type PreparedRun,
  type RunDesk,
} from '../itest/run-desk.js';

/** Incidents raised and resolved by hand: one open per run, a reused id refused, a resolution kept. */

const responses = guardDeclaredResponses(streamingServiceApi);

let desk: RunDesk;

beforeAll(async () => {
  desk = await startRunDesk('streaming_incidents_itest', responses);
}, STARTUP_MS);

afterAll(async () => {
  await stopRunDesk(desk);
});

const MESSAGE = { contentLanguage: Locale.FR, text: 'Nous revenons dans un instant.' };

function raise(run: PreparedRun, incidentId: string = randomUUID()) {
  return studioCall(desk, 'POST', `/v1/dates/${run.dateId}/incidents`, {
    body: {
      incidentId,
      kind: IncidentKind.HOLD_SCREEN,
      cause: IncidentCause.BITRATE_COLLAPSED,
      message: MESSAGE,
    },
  });
}

function resolve(incidentId: string) {
  return studioCall(desk, 'POST', `/v1/incidents/${incidentId}/resolve`);
}

async function onAir(): Promise<PreparedRun> {
  const run = await preparedRun(desk);
  await feedOn(desk, run);
  await studioCall(desk, 'POST', `/v1/dates/${run.dateId}/run/technical-check`);
  await studioCall(desk, 'POST', `/v1/dates/${run.dateId}/run/go-on-air`, {
    body: { expectedVersion: 2 },
  });
  return run;
}

describe('raiseIncident', () => {
  it(
    'interrupts a run on air with its cause, the veil read by readRunFacts',
    async () => {
      const run = await onAir();
      const incidentId = randomUUID();
      expect((await raise(run, incidentId)).statusCode).toBe(201);

      const facts = await readRunFacts(desk.dataSource.manager, run.dateId);
      expect(facts).toMatchObject({
        state: RunState.INTERRUPTED,
        streamPath: run.streamPath,
        incident: { id: incidentId, kind: IncidentKind.HOLD_SCREEN, message: MESSAGE },
      });

      const rows = await outboxOf(desk, run.dateId);
      const [raised, interrupted] = rows.slice(-2);
      expect(raised?.type).toBe('streaming.incident.raised.v1');
      expect(fromBinary(IncidentRaisedSchema, raised?.payload ?? new Uint8Array())).toMatchObject({
        incidentId,
        message: MESSAGE,
      });
      expect(interrupted?.type).toBe('streaming.run.state_changed.v1');
      expect(
        fromBinary(RunStateChangedSchema, interrupted?.payload ?? new Uint8Array()),
      ).toMatchObject({ dateId: run.dateId, afterGracePeriod: false });
    },
    CASE_MS,
  );

  it(
    'holds one open at a time, and refuses a reused incidentId 409',
    async () => {
      const run = await preparedRun(desk);
      const first = randomUUID();
      expect((await raise(run, first)).statusCode).toBe(201);

      const second = await raise(run);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: { code: DomainErrorCode.STATE_CONFLICT } });

      await resolve(first);
      const reused = await raise(run, first);
      expect(reused.statusCode).toBe(409);
      expect(reused.json()).toMatchObject({ error: { code: DomainErrorCode.STATE_CONFLICT } });

      const elsewhere = await raise(await preparedRun(desk), first);
      expect(elsewhere.statusCode).toBe(409);

      const [open] = await desk.dataSource.query<{ open: number }[]>(
        'SELECT count(*)::int AS open FROM incident WHERE run_id = $1 AND resolved_at IS NULL',
        [run.runId],
      );
      expect(open?.open).toBe(0);
    },
    CASE_MS,
  );

  it(
    'is refused on an ended run',
    async () => {
      const run = await preparedRun(desk);
      await desk.dataSource.query('UPDATE run SET state = $2, ended_at = now() WHERE id = $1', [
        run.runId,
        RunState.ENDED,
      ]);
      expect((await raise(run)).statusCode).toBe(409);
    },
    CASE_MS,
  );
});

describe('resolveIncident', () => {
  it(
    'returns the run it interrupted to air, and answers the first resolution again',
    async () => {
      const run = await onAir();
      const incidentId = randomUUID();
      await raise(run, incidentId);
      const resolvedAt = desk.clock.now();

      const first = await resolve(incidentId);
      expect(first.json()).toMatchObject({ data: { resolvedAt } });
      expect((await readRunFacts(desk.dataSource.manager, run.dateId))?.state).toBe(
        RunState.ON_AIR,
      );

      desk.clock.advance(30_000);
      const again = await resolve(incidentId);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ data: { resolvedAt } });
      const resolutions = (await outboxOf(desk, run.dateId)).filter(
        ({ type }) => type === 'streaming.incident.resolved.v1',
      );
      expect(resolutions).toHaveLength(1);
    },
    CASE_MS,
  );
});
