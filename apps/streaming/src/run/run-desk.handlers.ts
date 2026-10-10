import {
  runIdempotently,
  runIdempotentlyVersioned,
  type MemorisedResponse,
} from '@arthome-platform/http-edge';
import { Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';

import {
  ApiErrorCode,
  DomainError,
  RunState,
  TECHNICAL_CHECK_BITRATE_FLOOR_KBPS_DEFAULT,
  technicalCheckFailuresOf,
  type Clock,
} from '@arthome/core';

import { READ_DATE_FACTS, type ReadDateFacts } from './date-facts.js';
import { recordRunEvents } from './record-run-events.js';
import {
  healthSampleOf,
  runConsoleOf,
  studioIncidentOf,
  type IncidentResolution,
  type RunConsole,
  type StudioIncident,
  type TechnicalCheckAnswer,
} from './run-console.js';
import { CheckRun, MoveRun, RaiseIncident, ResolveIncident } from './run-desk.commands.js';
import { IncidentRow } from './run.entity.js';
import { assertNever } from '../assert-never.js';
import { CLOCK } from '../clock.js';
import {
  codecsCarried,
  type LiveIngestProvider,
  type StreamingMetricsProvider,
} from '../media/media-ports.js';
import { LIVE_INGEST_PROVIDER, STREAMING_METRICS_PROVIDER } from '../media/media-tokens.js';
import { StreamingTransactions } from '../streaming-transactions.js';

/*
 * Each command is one transaction: the idempotency record claimed first, the run under its row lock
 *   (then its open incident's), the decision, the save and the outbox rows of its events. Reached
 *   from inside the service alone, so a refusal is core's `DomainError`: the route that dispatches
 *   it answers it on its declaration (`refusedOn`).
 */

function noRun(): DomainError {
  return new DomainError({ code: ApiErrorCode.NOT_FOUND });
}

@CommandHandler(MoveRun)
export class MoveRunHandler implements ICommandHandler<MoveRun> {
  public constructor(
    private readonly transactions: StreamingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(READ_DATE_FACTS) private readonly readDateFacts: ReadDateFacts,
    @Inject(LIVE_INGEST_PROVIDER) private readonly ingest: LiveIngestProvider,
  ) {}

  public execute({
    dateId,
    to,
    expectedVersion,
    call,
  }: MoveRun): Promise<MemorisedResponse<RunConsole>> {
    return this.transactions.run(({ manager, runs }) =>
      runIdempotentlyVersioned(manager, call.idempotency, this.clock, async () => {
        const run = await runs.findByDate(dateId);
        if (run === null) throw noRun();
        const now = this.clock.now();
        switch (to) {
          case RunState.IDLE:
            run.reset(expectedVersion, now);
            break;
          case RunState.REHEARSAL:
            run.rehearse(expectedVersion, now);
            break;
          case RunState.ON_AIR: {
            const facts = await this.readDateFacts(manager, dateId);
            run.goOnAir(expectedVersion, facts?.publicationState ?? null, call.actor, now);
            break;
          }
          case RunState.ENDED:
            run.end(expectedVersion, call.actor, now);
            break;
          default:
            return assertNever(to);
        }
        await runs.save(run);
        await recordRunEvents(manager, run.getUncommittedEvents(), call.traceparent);
        const { snapshot } = run;
        return {
          data: runConsoleOf(snapshot, run.openIncident, this.ingest),
          version: snapshot.version,
        };
      }),
    );
  }
}

/**
 * D-114: a feed received on the date's path (the authorizer admits only its key), in codecs the
 *   chain carries, above the floor. The sample is read under the run's lock, which a real
 *   adapter's call then bounds.
 */
@CommandHandler(CheckRun)
export class CheckRunHandler implements ICommandHandler<CheckRun> {
  public constructor(
    private readonly transactions: StreamingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LIVE_INGEST_PROVIDER) private readonly ingest: LiveIngestProvider,
    @Inject(STREAMING_METRICS_PROVIDER) private readonly metrics: StreamingMetricsProvider,
  ) {}

  public execute({ dateId, call }: CheckRun): Promise<MemorisedResponse<TechnicalCheckAnswer>> {
    return this.transactions.run(({ manager, runs }) =>
      runIdempotentlyVersioned(manager, call.idempotency, this.clock, async () => {
        const run = await runs.findByDate(dateId);
        if (run === null) throw noRun();
        const sample = await this.metrics.sample(run.snapshot.streamPath);
        const failures = technicalCheckFailuresOf(
          {
            feedReceived: sample !== null,
            codecCarried: sample !== null && codecsCarried(this.ingest.ingestCapabilities, sample),
            bitrateKbps: sample?.ingestUpKbps ?? Number.NaN,
          },
          TECHNICAL_CHECK_BITRATE_FLOOR_KBPS_DEFAULT,
        );
        const now = this.clock.now();
        const protocol = sample?.protocol ?? run.snapshot.ingestProtocol;
        const passed = run.runTechnicalCheck(failures, protocol, call.actor, now);
        await runs.save(run);
        await recordRunEvents(manager, run.getUncommittedEvents(), call.traceparent);
        return {
          data: {
            passed,
            passedAt: passed ? now : null,
            failures: [...failures],
            ...(sample !== null && { sample: healthSampleOf(sample) }),
          },
          version: run.snapshot.version,
        };
      }),
    );
  }
}

@CommandHandler(RaiseIncident)
export class RaiseIncidentHandler implements ICommandHandler<RaiseIncident> {
  public constructor(
    private readonly transactions: StreamingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute({
    dateId,
    incident,
    call,
  }: RaiseIncident): Promise<MemorisedResponse<NonNullable<StudioIncident>>> {
    return this.transactions.run(({ manager, runs }) =>
      runIdempotently(manager, call.idempotency, this.clock, async () => {
        const run = await runs.findByDate(dateId);
        if (run === null) throw noRun();
        run.raiseIncident(incident, call.actor, this.clock.now());
        await runs.save(run);
        await recordRunEvents(manager, run.getUncommittedEvents(), call.traceparent);
        const raised = run.openIncident;
        if (raised === null) throw new Error('an incident raised is the open one');
        return studioIncidentOf(raised);
      }),
    );
  }
}

/** An incident already resolved answers its resolution: the player lifts the veil without a new token. */
@CommandHandler(ResolveIncident)
export class ResolveIncidentHandler implements ICommandHandler<ResolveIncident> {
  public constructor(
    private readonly transactions: StreamingTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute({
    incidentId,
    call,
  }: ResolveIncident): Promise<MemorisedResponse<NonNullable<IncidentResolution>>> {
    return this.transactions.run(({ manager, runs }) =>
      runIdempotently(manager, call.idempotency, this.clock, async () => {
        // Read without a lock, so the run's row is still the first one this transaction locks.
        const located = await manager.findOneBy(IncidentRow, { id: incidentId });
        if (located === null) throw noRun();
        const run = await runs.findById(located.run_id);
        const now = this.clock.now();
        if (run?.resolveIncident(incidentId, call.actor, now) === true) {
          await runs.save(run);
          await recordRunEvents(manager, run.getUncommittedEvents(), call.traceparent);
          return { resolvedAt: now };
        }
        const resolved = await manager.findOneByOrFail(IncidentRow, { id: incidentId });
        return resolved.resolved_at === null
          ? {}
          : { resolvedAt: resolved.resolved_at.toISOString() };
      }),
    );
  }
}
