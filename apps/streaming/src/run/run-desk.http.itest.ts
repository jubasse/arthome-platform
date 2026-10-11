import { randomUUID } from 'node:crypto';

import { RunStartedSchema } from '@arthome-platform/events';
import { guardDeclaredResponses } from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { streamingServiceApi } from '@arthome/contracts/streaming-service-api';
import {
  ApiErrorCode,
  CatalogErrorCode,
  DomainErrorCode,
  IncidentCause,
  IncidentKind,
  IncidentTrigger,
  InternalTokenIssuer,
  Locale,
  PublicationState,
  RunState,
  Surface,
} from '@arthome/core';

import {
  CASE_MS,
  OPERATOR,
  STARTUP_MS,
  feedOn,
  outboxOf,
  preparedRun,
  startRunDesk,
  stopRunDesk,
  studioCall,
  versionOf,
  type RunDesk,
} from '../itest/run-desk.js';

/**
 * The run desk's eight routes through the module graph the API boots, over HTTP, every answer
 * checked against `streamingServiceApi`'s declaration.
 */

const responses = guardDeclaredResponses(streamingServiceApi);

let desk: RunDesk;

beforeAll(async () => {
  desk = await startRunDesk('streaming_run_desk_http_itest', { watch: responses });
}, STARTUP_MS);

afterAll(async () => {
  await stopRunDesk(desk);
});

const consoleUrl = (dateId: string) => `/v1/dates/${dateId}/run`;
const moveUrl = (dateId: string, move: string) => `/v1/dates/${dateId}/run/${move}`;

function move(dateId: string, to: string, expectedVersion: number, key: string = randomUUID()) {
  return studioCall(desk, 'POST', moveUrl(dateId, to), { body: { expectedVersion }, key });
}

function check(dateId: string) {
  return studioCall(desk, 'POST', moveUrl(dateId, 'technical-check'));
}

function raise(dateId: string, incidentId: string = randomUUID()) {
  return studioCall(desk, 'POST', `/v1/dates/${dateId}/incidents`, {
    body: {
      incidentId,
      kind: IncidentKind.HOLD_SCREEN,
      cause: IncidentCause.MANUAL,
      message: { contentLanguage: Locale.FR, text: 'Nous revenons.' },
    },
  });
}

function errorOf(response: { json: () => unknown }) {
  return (response.json() as { error: { code: string; params: unknown } }).error;
}

describe('getRunConsole', () => {
  it(
    'answers the whole console, with the sample measured and no stream key',
    async () => {
      const run = await preparedRun(desk);
      await feedOn(desk, run);

      const response = await studioCall(desk, 'GET', consoleUrl(run.dateId));

      expect(response.statusCode).toBe(200);
      const { data } = response.json<{ data: Record<string, unknown> }>();
      expect(data).toMatchObject({
        dateId: run.dateId,
        state: RunState.IDLE,
        afterGracePeriod: false,
        ingestProtocol: 'rtmps',
        monitorPath: 'll_hls',
        incident: null,
        version: 1,
        lastSample: { source: 'ingest_server', ingestUpKbps: 4500 },
      });
      expect(data.monitorUrl).toEqual(expect.any(String));
      expect(response.body).not.toContain(run.key);
    },
    CASE_MS,
  );

  it(
    'answers 404 for a date with no run, 400 with no deadline, 504 past it',
    async () => {
      const unknown = await studioCall(desk, 'GET', consoleUrl(randomUUID()));
      expect(unknown.statusCode).toBe(404);
      expect(errorOf(unknown).code).toBe(ApiErrorCode.NOT_FOUND);

      const run = await preparedRun(desk);
      const undated = await studioCall(desk, 'GET', consoleUrl(run.dateId), { deadline: null });
      expect(undated.statusCode).toBe(400);
      expect(errorOf(undated).code).toBe(ApiErrorCode.SCHEMA_INVALID);

      const past = new Date(desk.clock.nowMs() - 1).toISOString();
      const late = await studioCall(desk, 'GET', consoleUrl(run.dateId), { deadline: past });
      expect(late.statusCode).toBe(504);
      expect(errorOf(late).code).toBe(ApiErrorCode.DEADLINE_EXCEEDED);
    },
    CASE_MS,
  );

  it(
    "refuses 403 a caller that is not the studio's BFF",
    async () => {
      const run = await preparedRun(desk);
      const response = await studioCall(desk, 'GET', consoleUrl(run.dateId), {
        issuer: InternalTokenIssuer.STOREFRONT_BFF,
      });
      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe(ApiErrorCode.FORBIDDEN);
    },
    CASE_MS,
  );
});

describe('the moves', () => {
  it(
    'rehearse, check, go on air and end, the outbox rows in order on the date key',
    async () => {
      const run = await preparedRun(desk);
      await feedOn(desk, run);

      const rehearsed = await move(run.dateId, 'rehearse', 1);
      expect(rehearsed.statusCode).toBe(200);
      expect(rehearsed.json()).toMatchObject({ data: { state: RunState.REHEARSAL, version: 2 } });

      const checked = await check(run.dateId);
      expect(checked.statusCode).toBe(200);
      expect(checked.json()).toMatchObject({ data: { passed: true, failures: [] } });

      const onAir = await move(run.dateId, 'go-on-air', 3);
      expect(onAir.statusCode).toBe(200);
      expect(onAir.json()).toMatchObject({
        data: { state: RunState.ON_AIR, startedAt: desk.clock.now(), version: 4 },
      });

      const ended = await move(run.dateId, 'end', 4);
      expect(ended.json()).toMatchObject({ data: { state: RunState.ENDED, version: 5 } });

      const rows = await outboxOf(desk, run.dateId);
      expect(rows.map(({ type }) => type)).toEqual([
        'streaming.run.state_changed.v1',
        'streaming.run.technical_check_passed.v1',
        'streaming.run.started.v1',
        'streaming.run.state_changed.v1',
        'streaming.run.ended.v1',
        'streaming.run.state_changed.v1',
      ]);
      expect(new Set(rows.map(({ aggregatetype }) => aggregatetype))).toEqual(
        new Set(['streaming.run']),
      );
      const started = fromBinary(RunStartedSchema, rows[2]?.payload ?? new Uint8Array());
      expect(started).toMatchObject({ dateId: run.dateId, startedBy: { accountId: OPERATOR } });
    },
    CASE_MS,
  );

  it(
    'replays a key with the first answer, and refuses a stale version 409 with the version',
    async () => {
      const run = await preparedRun(desk);
      const key = randomUUID();
      const first = await move(run.dateId, 'rehearse', 1, key);
      const again = await move(run.dateId, 'rehearse', 1, key);
      expect(again.statusCode).toBe(200);
      expect(again.body).toBe(first.body);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(await versionOf(desk, run.dateId)).toBe(2);

      const stale = await move(run.dateId, 'reset', 1);
      expect(stale.statusCode).toBe(409);
      expect(errorOf(stale)).toMatchObject({
        code: DomainErrorCode.STATE_CONFLICT,
        params: { currentVersion: 2 },
      });
    },
    CASE_MS,
  );

  it(
    'refuses a move off the table 409 run.transition_forbidden',
    async () => {
      const run = await preparedRun(desk);
      const response = await move(run.dateId, 'end', 1);
      expect(response.statusCode).toBe(409);
      expect(errorOf(response)).toMatchObject({
        code: DomainErrorCode.RUN_TRANSITION_FORBIDDEN,
        params: { from: RunState.IDLE, to: RunState.ENDED },
      });
    },
    CASE_MS,
  );

  it(
    'refuses goOnAir before a pass, on a publication not technical, and with an incident open',
    async () => {
      const unchecked = await preparedRun(desk);
      const beforePass = await move(unchecked.dateId, 'go-on-air', 1);
      expect(beforePass.statusCode).toBe(409);
      expect(errorOf(beforePass).code).toBe(CatalogErrorCode.TECHNICAL_CHECK_REQUIRED);

      const scheduled = await preparedRun(desk, { publicationState: PublicationState.SCHEDULED });
      await feedOn(desk, scheduled);
      await check(scheduled.dateId);
      const notTechnical = await move(scheduled.dateId, 'go-on-air', 2);
      expect(notTechnical.statusCode).toBe(409);
      expect(errorOf(notTechnical)).toMatchObject({
        code: DomainErrorCode.PUBLICATION_TRANSITION_FORBIDDEN,
        params: { from: PublicationState.SCHEDULED, to: PublicationState.LIVE },
      });

      const veiled = await preparedRun(desk);
      await feedOn(desk, veiled);
      await check(veiled.dateId);
      await raise(veiled.dateId);
      const underIncident = await move(veiled.dateId, 'go-on-air', 3);
      expect(underIncident.statusCode).toBe(409);
      expect(errorOf(underIncident).code).toBe(DomainErrorCode.STATE_CONFLICT);
      expect(await outboxOf(desk, veiled.dateId)).not.toContainEqual(
        expect.objectContaining({ type: 'streaming.run.started.v1' }),
      );
    },
    CASE_MS,
  );

  it(
    'refuses a write with no deadline, and one with no idempotency key, before any work',
    async () => {
      const run = await preparedRun(desk);
      const undated = await studioCall(desk, 'POST', moveUrl(run.dateId, 'rehearse'), {
        body: { expectedVersion: 1 },
        deadline: null,
      });
      expect(undated.statusCode).toBe(400);
      const unkeyed = await studioCall(desk, 'POST', moveUrl(run.dateId, 'rehearse'), {
        body: { expectedVersion: 1 },
        key: null,
      });
      expect(unkeyed.statusCode).toBe(400);
      expect(await versionOf(desk, run.dateId)).toBe(1);
    },
    CASE_MS,
  );

  it(
    'answers 404 on a date with no run',
    async () => {
      const response = await move(randomUUID(), 'rehearse', 1);
      expect(response.statusCode).toBe(404);
    },
    CASE_MS,
  );
});

describe('incidents over HTTP', () => {
  it(
    'raise 201 and resolve 200, the run back on air',
    async () => {
      const run = await preparedRun(desk);
      await feedOn(desk, run);
      await check(run.dateId);
      await move(run.dateId, 'go-on-air', 2);
      const incidentId = randomUUID();

      const raised = await raise(run.dateId, incidentId);
      expect(raised.statusCode).toBe(201);
      expect(raised.json()).toMatchObject({
        data: { id: incidentId, kind: IncidentKind.HOLD_SCREEN, trigger: IncidentTrigger.MANUAL },
      });

      const resolved = await studioCall(desk, 'POST', `/v1/incidents/${incidentId}/resolve`);
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json()).toMatchObject({ data: { resolvedAt: desk.clock.now() } });

      const console = await studioCall(desk, 'GET', consoleUrl(run.dateId));
      expect(console.json()).toMatchObject({ data: { state: RunState.ON_AIR, incident: null } });
    },
    CASE_MS,
  );

  it(
    'answers 404 for an unknown incident',
    async () => {
      const response = await studioCall(desk, 'POST', `/v1/incidents/${randomUUID()}/resolve`);
      expect(response.statusCode).toBe(404);
    },
    CASE_MS,
  );
});

describe('the operator', () => {
  it(
    'refuses 403 a write with no user, or on the system surface, and moves nothing',
    async () => {
      const run = await preparedRun(desk);
      const writes = [
        { url: moveUrl(run.dateId, 'rehearse'), body: { expectedVersion: 1 } },
        { url: moveUrl(run.dateId, 'technical-check') },
        { url: `/v1/incidents/${randomUUID()}/resolve` },
      ];
      for (const write of writes) {
        for (const caller of [{ accountId: null }, { surface: Surface.SYSTEM }]) {
          const response = await studioCall(desk, 'POST', write.url, { ...write, ...caller });
          expect(response.statusCode).toBe(403);
          expect(errorOf(response).code).toBe(ApiErrorCode.FORBIDDEN);
        }
      }
      expect(await versionOf(desk, run.dateId)).toBe(1);
    },
    CASE_MS,
  );
});
