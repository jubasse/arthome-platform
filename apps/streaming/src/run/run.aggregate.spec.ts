import { describe, expect, it } from 'vitest';

import {
  CatalogErrorCode,
  DomainError,
  DomainErrorCode,
  IncidentCause,
  IncidentKind,
  IncidentTrigger,
  Locale,
  PublicationState,
  RUN_TRANSITIONS,
  RunState,
  Surface,
  TechnicalCheckFailure,
  plusMinutes,
  plusSeconds,
  type Instant,
} from '@arthome/core';

import { Run, SYSTEM_ACTOR, type RunSnapshot } from './run.aggregate.js';
import {
  IncidentRaised,
  IncidentResolved,
  RunEnded,
  RunPrepared,
  RunStarted,
  RunStateChanged,
  TechnicalCheckPassed,
  type RunActor,
} from './run.events.js';
import { IngestProtocol, MonitorPath } from '../media/media-ports.js';

const RUN_ID = '01a0f000-0000-7000-8000-000000000001';
const DATE_ID = '01a0f000-0000-7000-8000-000000000002';
const CHANNEL_ID = '01a0f000-0000-7000-8000-000000000003';
const INCIDENT_ID = '01a0f000-0000-7000-8000-000000000004';
const OPERATOR = '01a0f000-0000-7000-8000-000000000005';
const NOW = '2026-09-29T20:00:00.000Z';
const ACTOR: RunActor = { accountId: OPERATOR, surface: Surface.STUDIO_WEB };
const MESSAGE = { contentLanguage: Locale.FR, text: 'Nous revenons dans un instant.' };

function runIn(state: RunState, overrides: Partial<RunSnapshot> = {}): Run {
  return Run.restore({
    runId: RUN_ID,
    dateId: DATE_ID,
    channelId: CHANNEL_ID,
    state,
    streamPath: 'path',
    ingestProtocol: IngestProtocol.RTMPS,
    monitorPath: MonitorPath.LL_HLS,
    technicalCheckPassedAt: '2026-09-29T19:00:00.000Z',
    startedAt: state === RunState.ON_AIR || state === RunState.INTERRUPTED ? NOW : null,
    endedAt: state === RunState.ENDED ? NOW : null,
    publisherOnlineSince: null,
    publisherLostAt: null,
    afterGracePeriod: false,
    incident: null,
    version: 3,
    ...overrides,
  });
}

function refusal(act: () => void): unknown {
  try {
    act();
  } catch (error) {
    if (!(error instanceof DomainError)) return error;
    const { code, params } = error as DomainError & { readonly params: unknown };
    return { code, params };
  }
  return null;
}

function lostSince(lostAt: Instant): Partial<RunSnapshot> {
  return { publisherLostAt: lostAt, publisherOnlineSince: null };
}

describe('Run.prepare', () => {
  it('is idle on rtmps at version 1, with nothing on the wire', () => {
    const run = Run.prepare(
      { runId: RUN_ID, dateId: DATE_ID, channelId: CHANNEL_ID, streamPath: 'path' },
      NOW,
    );
    expect(run.snapshot).toMatchObject({
      state: RunState.IDLE,
      ingestProtocol: IngestProtocol.RTMPS,
      monitorPath: MonitorPath.LL_HLS,
      technicalCheckPassedAt: null,
      version: 1,
    });
    expect(run.getUncommittedEvents()).toEqual([new RunPrepared(DATE_ID, NOW)]);
  });
});

describe('the moves the studio asks for', () => {
  const moves = [
    [RunState.REHEARSAL, (run: Run) => run.rehearse(3, NOW)],
    [RunState.IDLE, (run: Run) => run.reset(3, NOW)],
    [RunState.ON_AIR, (run: Run) => run.goOnAir(3, PublicationState.TECHNICAL, ACTOR, NOW)],
    [RunState.ENDED, (run: Run) => run.end(3, ACTOR, NOW)],
  ] as const;

  for (const from of Object.keys(RUN_TRANSITIONS) as RunState[]) {
    for (const [to, move] of moves) {
      const allowed = RUN_TRANSITIONS[from].includes(to);
      it(`${from} to ${to} ${allowed ? 'moves, at the next version' : 'is refused'}`, () => {
        const run = runIn(from);
        if (allowed) {
          move(run);
          expect(run.snapshot).toMatchObject({ state: to, version: 4 });
          expect(run.getUncommittedEvents().at(-1)).toEqual(
            new RunStateChanged(DATE_ID, to, null, false, NOW),
          );
        } else {
          expect(refusal(() => move(run))).toEqual({
            code: DomainErrorCode.RUN_TRANSITION_FORBIDDEN,
            params: { from, to },
          });
          expect(run.snapshot.version).toBe(3);
        }
      });
    }
  }

  it('refuses a stale version, naming the current one and the state', () => {
    expect(refusal(() => runIn(RunState.IDLE).rehearse(2, NOW))).toEqual({
      code: DomainErrorCode.STATE_CONFLICT,
      params: { currentVersion: 3, state: RunState.IDLE },
    });
  });

  it('goes on air only after a passed check, one being enough', () => {
    const unchecked = runIn(RunState.REHEARSAL, { technicalCheckPassedAt: null });
    expect(refusal(() => unchecked.goOnAir(3, PublicationState.TECHNICAL, ACTOR, NOW))).toEqual({
      code: CatalogErrorCode.TECHNICAL_CHECK_REQUIRED,
      params: {},
    });
  });

  it('goes on air only from a technical publication, `none` when none is projected', () => {
    expect(
      refusal(() => runIn(RunState.REHEARSAL).goOnAir(3, PublicationState.SCHEDULED, ACTOR, NOW)),
    ).toEqual({
      code: DomainErrorCode.PUBLICATION_TRANSITION_FORBIDDEN,
      params: { from: PublicationState.SCHEDULED, to: PublicationState.LIVE },
    });
    expect(refusal(() => runIn(RunState.REHEARSAL).goOnAir(3, null, ACTOR, NOW))).toEqual({
      code: DomainErrorCode.PUBLICATION_TRANSITION_FORBIDDEN,
      params: { from: 'none', to: PublicationState.LIVE },
    });
  });

  it('never goes on air under an open incident', () => {
    const run = runIn(RunState.REHEARSAL);
    run.raiseIncident(
      {
        id: INCIDENT_ID,
        kind: IncidentKind.HOLD_SCREEN,
        cause: IncidentCause.MANUAL,
        message: MESSAGE,
      },
      ACTOR,
      NOW,
    );
    expect(refusal(() => run.goOnAir(4, PublicationState.TECHNICAL, ACTOR, NOW))).toEqual({
      code: DomainErrorCode.STATE_CONFLICT,
      params: { currentVersion: 4, state: RunState.REHEARSAL },
    });
  });

  it('starts with the actor, the protocol and the monitor path', () => {
    const run = runIn(RunState.REHEARSAL);
    run.goOnAir(3, PublicationState.TECHNICAL, ACTOR, NOW);
    expect(run.snapshot.startedAt).toBe(NOW);
    expect(run.getUncommittedEvents()[0]).toEqual(
      new RunStarted(DATE_ID, CHANNEL_ID, IngestProtocol.RTMPS, MonitorPath.LL_HLS, ACTOR, NOW),
    );
  });

  it('ends with its duration from the start, and ended is final', () => {
    const run = runIn(RunState.ON_AIR, { startedAt: plusMinutes(NOW, -90) });
    run.end(3, ACTOR, NOW);
    expect(run.getUncommittedEvents()[0]).toEqual(
      new RunEnded(DATE_ID, CHANNEL_ID, NOW, 5400, ACTOR, NOW),
    );
    expect(RUN_TRANSITIONS[RunState.ENDED]).toEqual([]);
  });
});

describe('the technical check', () => {
  it('records the first pass at the next version, and keeps it after', () => {
    const run = runIn(RunState.IDLE, { technicalCheckPassedAt: null });
    expect(run.runTechnicalCheck([], IngestProtocol.SRT, ACTOR, NOW)).toBe(true);
    expect(run.snapshot).toMatchObject({ technicalCheckPassedAt: NOW, version: 4 });

    const later = plusMinutes(NOW, 5);
    expect(run.runTechnicalCheck([], IngestProtocol.SRT, ACTOR, later)).toBe(true);
    expect(run.snapshot).toMatchObject({ technicalCheckPassedAt: NOW, version: 4 });
    expect(run.getUncommittedEvents()).toEqual([
      new TechnicalCheckPassed(DATE_ID, CHANNEL_ID, IngestProtocol.SRT, ACTOR, NOW),
      new TechnicalCheckPassed(DATE_ID, CHANNEL_ID, IngestProtocol.SRT, ACTOR, later),
    ]);
  });

  it('records nothing on a failure, and is refused on an ended run', () => {
    const run = runIn(RunState.IDLE, { technicalCheckPassedAt: null });
    const failures = [TechnicalCheckFailure.BITRATE_BELOW_FLOOR];
    expect(run.runTechnicalCheck(failures, IngestProtocol.RTMPS, ACTOR, NOW)).toBe(false);
    expect(run.snapshot.version).toBe(3);
    expect(run.getUncommittedEvents()).toEqual([]);
    expect(
      refusal(() => runIn(RunState.ENDED).runTechnicalCheck([], IngestProtocol.RTMPS, ACTOR, NOW)),
    ).toMatchObject({ code: DomainErrorCode.STATE_CONFLICT });
  });
});

describe('incidents', () => {
  const raised = {
    id: INCIDENT_ID,
    kind: IncidentKind.HOLD_SCREEN,
    cause: IncidentCause.PROVIDER_ERROR,
    message: MESSAGE,
  };

  it('interrupt a run on air only, with their cause', () => {
    const onAir = runIn(RunState.ON_AIR);
    onAir.raiseIncident(raised, ACTOR, NOW);
    expect(onAir.snapshot).toMatchObject({ state: RunState.INTERRUPTED, version: 4 });
    expect(onAir.getUncommittedEvents()).toEqual([
      new IncidentRaised(
        DATE_ID,
        CHANNEL_ID,
        {
          ...raised,
          trigger: IncidentTrigger.MANUAL,
          raisedAt: NOW,
          raisedBy: OPERATOR,
          resolvedAt: null,
          resolvedBy: null,
        },
        ACTOR,
        NOW,
      ),
      new RunStateChanged(DATE_ID, RunState.INTERRUPTED, IncidentCause.PROVIDER_ERROR, false, NOW),
    ]);

    const rehearsing = runIn(RunState.REHEARSAL);
    rehearsing.raiseIncident(raised, ACTOR, NOW);
    expect(rehearsing.snapshot).toMatchObject({ state: RunState.REHEARSAL, version: 4 });
    expect(rehearsing.getUncommittedEvents()).toHaveLength(1);
  });

  it('are one open at a time, and none on an ended run', () => {
    const run = runIn(RunState.ON_AIR);
    run.raiseIncident(raised, ACTOR, NOW);
    expect(refusal(() => run.raiseIncident({ ...raised, id: RUN_ID }, ACTOR, NOW))).toMatchObject({
      code: DomainErrorCode.STATE_CONFLICT,
    });
    expect(refusal(() => runIn(RunState.ENDED).raiseIncident(raised, ACTOR, NOW))).toMatchObject({
      code: DomainErrorCode.STATE_CONFLICT,
    });
  });

  it('resolved, return the run they interrupted to air; resolved twice, change nothing', () => {
    const run = runIn(RunState.ON_AIR);
    run.raiseIncident(raised, ACTOR, NOW);
    run.uncommit();
    const later = plusMinutes(NOW, 2);
    expect(run.resolveIncident(INCIDENT_ID, ACTOR, later)).toBe(true);
    expect(run.snapshot).toMatchObject({ state: RunState.ON_AIR, version: 5 });
    expect(run.openIncident).toBeNull();
    expect(run.getUncommittedEvents()).toEqual([
      new IncidentResolved(DATE_ID, INCIDENT_ID, ACTOR, later),
      new RunStateChanged(DATE_ID, RunState.ON_AIR, null, false, later),
    ]);
    expect(run.resolveIncident(INCIDENT_ID, ACTOR, later)).toBe(false);
    expect(run.snapshot.version).toBe(5);
  });
});

describe('presence', () => {
  it('never moves the version: a publisher gone past the grace is presence alone', () => {
    const run = runIn(RunState.ON_AIR, lostSince(plusSeconds(NOW, -4)));
    expect(run.declarePublisherGone(NOW)).toBe(false);

    const gone = runIn(RunState.ON_AIR, lostSince(plusSeconds(NOW, -5)));
    expect(gone.declarePublisherGone(NOW)).toBe(true);
    expect(gone.snapshot).toMatchObject({ afterGracePeriod: true, version: 3 });
    expect(gone.getUncommittedEvents()).toEqual([
      new RunStateChanged(DATE_ID, RunState.ON_AIR, null, true, NOW),
    ]);
    expect(gone.declarePublisherGone(NOW)).toBe(false);
  });

  it('raises the automatic hold screen at its delay, never inside the grace', () => {
    expect(
      runIn(RunState.ON_AIR, lostSince(plusSeconds(NOW, -14))).raiseHoldScreenIfFeedLost(
        INCIDENT_ID,
        NOW,
      ),
    ).toBe(false);
    const run = runIn(RunState.ON_AIR, lostSince(plusSeconds(NOW, -15)));
    expect(run.raiseHoldScreenIfFeedLost(INCIDENT_ID, NOW)).toBe(true);
    expect(run.snapshot.state).toBe(RunState.INTERRUPTED);
    expect(run.openIncident).toMatchObject({
      kind: IncidentKind.HOLD_SCREEN,
      cause: IncidentCause.VENUE_FEED_LOST,
      trigger: IncidentTrigger.AUTO,
      raisedBy: null,
      message: null,
    });
    expect(
      runIn(RunState.REHEARSAL, lostSince(plusSeconds(NOW, -60))).raiseHoldScreenIfFeedLost(
        INCIDENT_ID,
        NOW,
      ),
    ).toBe(false);
  });

  it('back, lifts the automatic hold screen of a lost feed (D-124), not one raised by hand', () => {
    const auto = runIn(RunState.ON_AIR, lostSince(plusSeconds(NOW, -20)));
    auto.raiseHoldScreenIfFeedLost(INCIDENT_ID, NOW);
    auto.uncommit();
    auto.publisherBack(true, NOW);
    expect(auto.snapshot).toMatchObject({ state: RunState.ON_AIR, version: 5 });
    expect(auto.getUncommittedEvents()).toEqual([
      new IncidentResolved(DATE_ID, INCIDENT_ID, SYSTEM_ACTOR, NOW),
      new RunStateChanged(DATE_ID, RunState.ON_AIR, null, false, NOW),
    ]);

    const manual = runIn(RunState.ON_AIR);
    manual.raiseIncident(
      {
        id: INCIDENT_ID,
        kind: IncidentKind.HOLD_SCREEN,
        cause: IncidentCause.VENUE_FEED_LOST,
        message: MESSAGE,
      },
      ACTOR,
      NOW,
    );
    manual.uncommit();
    manual.publisherBack(false, NOW);
    expect(manual.snapshot).toMatchObject({ state: RunState.INTERRUPTED, version: 4 });
    expect(manual.getUncommittedEvents()).toEqual([]);
  });

  it('back after the grace, clears "publisher gone" with the version unmoved', () => {
    const run = runIn(RunState.ON_AIR);
    run.publisherBack(true, NOW);
    expect(run.snapshot.version).toBe(3);
    expect(run.getUncommittedEvents()).toEqual([
      new RunStateChanged(DATE_ID, RunState.ON_AIR, null, false, NOW),
    ]);
  });

  it('a final worker failure raises its own automatic incident, logged when one is open', () => {
    const run = runIn(RunState.ON_AIR);
    expect(run.raiseWorkerFailure(INCIDENT_ID, NOW)).toBe(true);
    expect(run.openIncident).toMatchObject({
      cause: IncidentCause.COMPATIBILITY_WORKER_FAILED,
      trigger: IncidentTrigger.AUTO,
    });
    expect(run.raiseWorkerFailure(RUN_ID, NOW)).toBe(false);
    expect(runIn(RunState.ENDED).raiseWorkerFailure(INCIDENT_ID, NOW)).toBe(false);
  });
});

describe('the end by itself (D-123)', () => {
  const scheduledEnd = '2026-09-29T21:30:00.000Z';

  it('comes fifteen minutes after the scheduled end with no publisher ever online', () => {
    const run = runIn(RunState.ON_AIR);
    expect(run.endByItself(scheduledEnd, plusMinutes(scheduledEnd, 14))).toBe(false);
    const now = plusMinutes(scheduledEnd, 15);
    expect(run.endByItself(scheduledEnd, now)).toBe(true);
    expect(run.snapshot).toMatchObject({
      state: RunState.ENDED,
      endedAt: scheduledEnd,
      version: 4,
    });
    expect(run.getUncommittedEvents()[0]).toMatchObject({
      kind: 'RunEnded',
      endedAt: scheduledEnd,
      endedBy: SYSTEM_ACTOR,
      occurredAt: now,
    });
  });

  it('ends at the last loss, after the later of it and the scheduled end', () => {
    const lostAt = plusMinutes(scheduledEnd, 10);
    const run = runIn(RunState.INTERRUPTED, lostSince(lostAt));
    expect(run.endByItself(scheduledEnd, plusMinutes(lostAt, 14))).toBe(false);
    expect(run.endByItself(scheduledEnd, plusMinutes(lostAt, 15))).toBe(true);
    expect(run.snapshot.endedAt).toBe(lostAt);
  });

  it('never while a publisher is online, overrunning or not', () => {
    const run = runIn(RunState.ON_AIR, { publisherOnlineSince: NOW });
    expect(run.endByItself(scheduledEnd, plusMinutes(scheduledEnd, 600))).toBe(false);
  });
});
