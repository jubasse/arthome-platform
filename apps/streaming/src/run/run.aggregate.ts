import { frozen } from '@arthome-platform/transactions';
import { AggregateRoot } from '@nestjs/cqrs';

import {
  DomainError,
  DomainErrorCode,
  HOLD_SCREEN_AUTO_AFTER_SECONDS_DEFAULT,
  IncidentCause,
  IncidentKind,
  IncidentTrigger,
  PUBLISHER_GRACE_SECONDS,
  PublicationState,
  RunState,
  Surface,
  assertRunTransition,
  holdScreenLiftsOnFeedReturn,
  isAfter,
  plusSeconds,
  runAutoEndsAt,
  toEpochMs,
  type Instant,
  type TechnicalCheckFailure,
} from '@arthome/core';

import type { IncidentSnapshot, RaisedIncident } from './incident.js';
import {
  IncidentRaised,
  IncidentResolved,
  RunEnded,
  RunPrepared,
  RunStarted,
  RunStateChanged,
  TechnicalCheckPassed,
  type RunActor,
  type RunEvent,
} from './run.events.js';
import { IngestProtocol, MonitorPath } from '../media/media-ports.js';

export interface RunSnapshot {
  readonly runId: string;
  readonly dateId: string;
  readonly channelId: string;
  readonly state: RunState;
  readonly streamPath: string;
  readonly ingestProtocol: IngestProtocol;
  readonly monitorPath: MonitorPath;
  readonly technicalCheckPassedAt: Instant | null;
  readonly startedAt: Instant | null;
  readonly endedAt: Instant | null;
  readonly publisherOnlineSince: Instant | null;
  readonly publisherLostAt: Instant | null;
  readonly afterGracePeriod: boolean;
  /** The open incident, or the one this aggregate has just resolved. */
  readonly incident: IncidentSnapshot | null;
  readonly version: number;
}

export interface RunToPrepare {
  readonly runId: string;
  readonly dateId: string;
  readonly channelId: string;
  readonly streamPath: string;
}

export const SYSTEM_ACTOR: RunActor = { accountId: null, surface: Surface.SYSTEM };

/** `publication.transition_forbidden`'s `from` when no publication state is projected. */
export const NO_PUBLICATION = 'none';

/**
 * A date's run and its incidents (`data-model.md` §5.1, §5.6). The version counts state, not
 *   presence: a transition, an incident and a first passed check advance it, a publisher's comings
 *   and goings and `afterGracePeriod` never do, so a flapping feed never makes a studio command
 *   stale. `on_air` always means on air with no veil: an incident raised on air interrupts the run,
 *   and the run goes on air only with none open. A method never awaits: what a rule needs beyond
 *   the aggregate is an argument.
 */
export class Run extends AggregateRoot<RunEvent> {
  private current: RunSnapshot;

  private constructor(current: RunSnapshot) {
    super();
    this.current = frozen(current);
  }

  public static restore(snapshot: RunSnapshot): Run {
    return new Run(snapshot);
  }

  /** `rtmps` until a feed is accepted: the console needs a protocol, and it is the compatibility ingest. */
  public static prepare(run: RunToPrepare, now: Instant): Run {
    const prepared = new Run({
      ...run,
      state: RunState.IDLE,
      ingestProtocol: IngestProtocol.RTMPS,
      monitorPath: MonitorPath.LL_HLS,
      technicalCheckPassedAt: null,
      startedAt: null,
      endedAt: null,
      publisherOnlineSince: null,
      publisherLostAt: null,
      afterGracePeriod: false,
      incident: null,
      version: 1,
    });
    prepared.apply(new RunPrepared(run.dateId, now));
    return prepared;
  }

  public get snapshot(): RunSnapshot {
    return this.current;
  }

  public get openIncident(): IncidentSnapshot | null {
    const { incident } = this.current;
    return incident?.resolvedAt === null ? incident : null;
  }

  public rehearse(expectedVersion: number, now: Instant): void {
    this.move(RunState.REHEARSAL, this.advancedFrom(expectedVersion), now);
  }

  public reset(expectedVersion: number, now: Instant): void {
    this.move(RunState.IDLE, this.advancedFrom(expectedVersion), now);
  }

  /**
   * Refused unless the projected publication is `technical`, the only state catalog's machine
   *   takes to `live` on `run.started` (any other start would be dead-lettered there).
   */
  public goOnAir(
    expectedVersion: number,
    publicationState: PublicationState | null,
    actor: RunActor,
    now: Instant,
  ): void {
    const version = this.advancedFrom(expectedVersion);
    assertRunTransition(this.current.state, RunState.ON_AIR, this.technicalCheckPassed);
    if (publicationState !== PublicationState.TECHNICAL) {
      throw new DomainError({
        code: DomainErrorCode.PUBLICATION_TRANSITION_FORBIDDEN,
        params: { from: publicationState ?? NO_PUBLICATION, to: PublicationState.LIVE },
      });
    }
    if (this.openIncident !== null) throw this.conflict();
    this.current = frozen({ ...this.current, state: RunState.ON_AIR, startedAt: now, version });
    const { dateId, channelId, ingestProtocol, monitorPath } = this.current;
    this.apply(new RunStarted(dateId, channelId, ingestProtocol, monitorPath, actor, now));
    this.applyStateChanged(now);
  }

  public end(expectedVersion: number, actor: RunActor, now: Instant): void {
    this.endAt(this.advancedFrom(expectedVersion), now, actor, now);
  }

  /**
   * D-123: a run left on air ends at `runAutoEndsAt`, its end the last publisher's loss, or the
   *   scheduled end when none was ever online, never before its start (a feed lost in rehearsal).
   *   False while a publisher is online, or before then.
   */
  public endByItself(scheduledEndsAt: Instant, now: Instant): boolean {
    const { state, publisherLostAt, publisherOnlineSince, startedAt, version } = this.current;
    if (state !== RunState.ON_AIR && state !== RunState.INTERRUPTED) return false;
    const endsAt = runAutoEndsAt(scheduledEndsAt, publisherLostAt, publisherOnlineSince !== null);
    if (endsAt === null || isAfter(endsAt, now)) return false;
    const lastFeed = publisherLostAt ?? scheduledEndsAt;
    const endedAt = startedAt !== null && isAfter(startedAt, lastFeed) ? startedAt : lastFeed;
    this.endAt(version + 1, endedAt, SYSTEM_ACTOR, now);
    return true;
  }

  /** True for a pass, recorded the first time only; refused on an ended run. */
  public runTechnicalCheck(
    failures: readonly TechnicalCheckFailure[],
    protocol: IngestProtocol,
    actor: RunActor,
    now: Instant,
  ): boolean {
    if (this.current.state === RunState.ENDED) throw this.conflict();
    if (failures.length > 0) return false;
    if (!this.technicalCheckPassed) {
      this.current = frozen({
        ...this.current,
        technicalCheckPassedAt: now,
        version: this.current.version + 1,
      });
    }
    const { dateId, channelId } = this.current;
    this.apply(new TechnicalCheckPassed(dateId, channelId, protocol, actor, now));
    return true;
  }

  public raiseIncident(raised: RaisedIncident, actor: RunActor, now: Instant): void {
    if (this.current.state === RunState.ENDED || this.openIncident !== null) throw this.conflict();
    this.raise(
      { ...raised, trigger: IncidentTrigger.MANUAL, raisedBy: actor.accountId },
      actor,
      now,
    );
  }

  /** False when `incidentId` is not the open incident: it was resolved before. */
  public resolveIncident(incidentId: string, actor: RunActor, now: Instant): boolean {
    const open = this.openIncident;
    if (open?.id !== incidentId) return false;
    this.resolve(open, actor, false, now);
    return true;
  }

  /** "Publisher gone" (`data-model.md` §5.1): a loss on air the grace did not absorb. Presence only. */
  public declarePublisherGone(now: Instant): boolean {
    if (this.current.afterGracePeriod || !this.feedLostFor(PUBLISHER_GRACE_SECONDS, now)) {
      return false;
    }
    this.current = frozen({ ...this.current, afterGracePeriod: true });
    this.applyStateChanged(now);
    return true;
  }

  /** D-124's automatic hold screen, at the channel's delay; never inside the grace. */
  public raiseHoldScreenIfFeedLost(incidentId: string, now: Instant): boolean {
    if (
      this.openIncident !== null ||
      !this.feedLostFor(HOLD_SCREEN_AUTO_AFTER_SECONDS_DEFAULT, now)
    ) {
      return false;
    }
    this.raiseAutomatic(incidentId, IncidentCause.VENUE_FEED_LOST, now);
    return true;
  }

  /**
   * A transcoding worker the provider stopped restarting (`streaming.md` §6). False on an ended
   *   run or with an incident open: the caller logs it. Lifted by the run desk alone (D-124).
   */
  public raiseWorkerFailure(incidentId: string, now: Instant): boolean {
    if (this.current.state === RunState.ENDED || this.openIncident !== null) return false;
    this.raiseAutomatic(incidentId, IncidentCause.COMPATIBILITY_WORKER_FAILED, now);
    return true;
  }

  /**
   * The publisher is back, its presence already written (`afterGracePeriod` false). D-124: the
   *   automatic hold screen of a lost feed lifts itself; one raised by hand stays.
   */
  public publisherBack(wasAfterGracePeriod: boolean, now: Instant): void {
    const open = this.openIncident;
    if (open !== null && holdScreenLiftsOnFeedReturn(open)) {
      this.resolve(open, SYSTEM_ACTOR, wasAfterGracePeriod, now);
    } else if (wasAfterGracePeriod) {
      this.applyStateChanged(now);
    }
  }

  private get technicalCheckPassed(): boolean {
    return this.current.technicalCheckPassedAt !== null;
  }

  private feedLostFor(seconds: number, now: Instant): boolean {
    const { state, publisherOnlineSince, publisherLostAt } = this.current;
    return (
      state === RunState.ON_AIR &&
      publisherOnlineSince === null &&
      publisherLostAt !== null &&
      !isAfter(plusSeconds(publisherLostAt, seconds), now)
    );
  }

  private move(to: RunState, version: number, now: Instant): void {
    assertRunTransition(this.current.state, to, this.technicalCheckPassed);
    this.current = frozen({ ...this.current, state: to, version });
    this.applyStateChanged(now);
  }

  /** An incident still open is resolved by the system first: an ended run carries no veil. */
  private endAt(version: number, endedAt: Instant, actor: RunActor, now: Instant): void {
    assertRunTransition(this.current.state, RunState.ENDED, this.technicalCheckPassed);
    const open = this.openIncident;
    const { dateId, channelId, startedAt } = this.current;
    this.current = frozen({
      ...this.current,
      ...(open !== null && {
        incident: { ...open, resolvedAt: now, resolvedBy: SYSTEM_ACTOR.accountId },
      }),
      state: RunState.ENDED,
      endedAt,
      version,
    });
    if (open !== null) this.apply(new IncidentResolved(dateId, open.id, SYSTEM_ACTOR, now));
    const durationMs = startedAt === null ? 0 : toEpochMs(endedAt) - toEpochMs(startedAt);
    const durationSec = Math.max(0, Math.round(durationMs / 1000));
    this.apply(new RunEnded(dateId, channelId, endedAt, durationSec, actor, now));
    this.applyStateChanged(now);
  }

  private raiseAutomatic(incidentId: string, cause: IncidentCause, now: Instant): void {
    this.raise(
      {
        id: incidentId,
        kind: IncidentKind.HOLD_SCREEN,
        cause,
        message: null,
        trigger: IncidentTrigger.AUTO,
        raisedBy: null,
      },
      SYSTEM_ACTOR,
      now,
    );
  }

  /** An incident veils; it interrupts only a run on air, since `run.state` is being on air. */
  private raise(
    raised: Omit<IncidentSnapshot, 'raisedAt' | 'resolvedAt' | 'resolvedBy'>,
    actor: RunActor,
    now: Instant,
  ): void {
    const { state, version } = this.current;
    const interrupts = state === RunState.ON_AIR;
    if (interrupts) assertRunTransition(state, RunState.INTERRUPTED, this.technicalCheckPassed);
    const incident: IncidentSnapshot = {
      ...raised,
      raisedAt: now,
      resolvedAt: null,
      resolvedBy: null,
    };
    this.current = frozen({
      ...this.current,
      incident,
      state: interrupts ? RunState.INTERRUPTED : state,
      version: version + 1,
    });
    const { dateId, channelId } = this.current;
    this.apply(new IncidentRaised(dateId, channelId, incident, actor, now));
    if (interrupts) this.applyStateChanged(now);
  }

  private resolve(
    open: IncidentSnapshot,
    actor: RunActor,
    afterGracePeriodCleared: boolean,
    now: Instant,
  ): void {
    const { state, version } = this.current;
    const resumes = state === RunState.INTERRUPTED;
    if (resumes) assertRunTransition(state, RunState.ON_AIR, this.technicalCheckPassed);
    this.current = frozen({
      ...this.current,
      incident: { ...open, resolvedAt: now, resolvedBy: actor.accountId },
      state: resumes ? RunState.ON_AIR : state,
      version: version + 1,
    });
    this.apply(new IncidentResolved(this.current.dateId, open.id, actor, now));
    if (resumes || afterGracePeriodCleared) this.applyStateChanged(now);
  }

  private applyStateChanged(now: Instant): void {
    const { dateId, state, afterGracePeriod } = this.current;
    const cause = state === RunState.INTERRUPTED ? (this.openIncident?.cause ?? null) : null;
    this.apply(new RunStateChanged(dateId, state, cause, afterGracePeriod, now));
  }

  private conflict(): DomainError {
    const { version, state } = this.current;
    return new DomainError({
      code: DomainErrorCode.STATE_CONFLICT,
      params: { currentVersion: version, state },
    });
  }

  /** Refuses a command that read another version, naming the current one; else the next version. */
  private advancedFrom(expectedVersion: number): number {
    if (this.current.version !== expectedVersion) throw this.conflict();
    return this.current.version + 1;
  }
}
