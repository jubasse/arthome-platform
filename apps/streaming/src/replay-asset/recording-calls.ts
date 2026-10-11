import { attemptsAllowedBy, doublingDelays, nextAttemptAt } from '@arthome-platform/messaging';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { HOUR_MS, ReplayAssetState, isAfter, toEpochMs, type Clock } from '@arthome/core';

import { writeAssetReady } from './replay-asset-wire.js';
import { RecordingCall, callDue, readinessAt } from './replay-asset.js';
import {
  CALL_DUE_NOW,
  lockAssetWaiting,
  lockAssetsDue,
  patchAsset,
  type LockedAsset,
} from './replay-asset.store.js';
import { CLOCK } from '../clock.js';
import { readDateFacts } from '../entitlement/entitlement-facts.js';
import {
  RecordingNotFound,
  type RecordingProvider,
  type RecordingRef,
  type RecordingStatus,
} from '../media/media-ports.js';
import { RECORDING_PROVIDER } from '../media/media-tokens.js';
import { readRunFacts } from '../run/run-facts.js';

/**
 * A recording is one call per date and step, with no rate limit to respect: the delay doubles from
 *   5 s to 5 min until an hour has passed (up to a fifth more with the jitter), the incident a
 *   provider can have, then the asset is `failed` and an operator reads it.
 */
export const RECORDING_RETRY_DELAYS_MS: readonly number[] = doublingDelays(
  5_000,
  5 * 60_000,
  HOUR_MS,
);
export const RECORDING_ATTEMPTS_MAX = attemptsAllowedBy(RECORDING_RETRY_DELAYS_MS);

/** A recording not ready is not a failed call: it is asked again after this, never counted. */
export const READINESS_POLL_EVERY_MS = 30_000;
/** Past this after the run's end the provider is not going to finish: the asset is `failed`. */
export const READINESS_GIVE_UP_AFTER_MS = 6 * HOUR_MS;

export const RECORDING_CALLS_BATCH = 20;

/**
 * Below the first retry delay, the claim's shortest lease: a call still in flight past its lease
 *   would be claimed again by another replica. A timeout is a failed attempt.
 */
export const RECORDING_CALL_TIMEOUT_MS = 4_000;

/** A started recording the asset cannot keep is deleted at the provider, retried this many times. */
export const ORPHAN_DELETE_ATTEMPTS = 3;

type CallResult =
  | { readonly call: typeof RecordingCall.START; readonly ref: RecordingRef }
  | { readonly call: typeof RecordingCall.STOP }
  | { readonly call: typeof RecordingCall.STATUS; readonly status: RecordingStatus }
  | { readonly call: typeof RecordingCall.DELETE };

/** A call the provider can never answer differently: given up at once, not after its attempts. */
class CallRefused extends Error {
  public override readonly name = 'CallRefused';
}

export class RecordingCallTimedOut extends Error {
  public override readonly name = 'RecordingCallTimedOut';

  public constructor() {
    super(`the recording provider did not answer within ${String(RECORDING_CALL_TIMEOUT_MS)} ms`);
  }
}

/**
 * Requirement 3: the provider's calls, each claimed `FOR UPDATE SKIP LOCKED` in a short transaction
 *   that counts the attempt and moves the next one out by the backoff before the call is made, so
 *   another replica skips it and a crash during the call leaves it due again then. The call runs
 *   outside any transaction, bounded by its timeout; its outcome is written in one of its own. Only
 *   a failed call counts toward the give-up: a recording started that the asset cannot keep, its
 *   outcome not written or the asset moved on, is deleted at the provider after the transaction.
 *   The `RecordingRef` stays in its column: no log, event or answer carries it, nor an error's
 *   message, which a provider may fill with it.
 */
@Injectable()
export class RecordingCalls {
  private readonly logger = new Logger(RecordingCalls.name);

  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RECORDING_PROVIDER) private readonly provider: RecordingProvider,
  ) {}

  /** The calls due, claimed then made one after the other; how many were claimed. */
  public async pass(batch: number = RECORDING_CALLS_BATCH): Promise<number> {
    const claimed = await this.claim(batch);
    for (const { asset, attempt } of claimed) await this.attempt(asset, attempt);
    return claimed.length;
  }

  private claim(batch: number): Promise<{ asset: LockedAsset; attempt: number }[]> {
    return this.dataSource.transaction(async (manager) => {
      const nowMs = this.clock.nowMs();
      const assets = await lockAssetsDue(manager, new Date(nowMs).toISOString(), batch);
      const claimed: { asset: LockedAsset; attempt: number }[] = [];
      for (const asset of assets) {
        if (callDue(asset) === null) continue;
        const attempt = asset.attempts + 1;
        // The last attempt's lease: nobody else asks while it is in flight.
        const lastLeaseMs = RECORDING_RETRY_DELAYS_MS.at(-1) ?? 0;
        const next =
          nextAttemptAt(attempt, nowMs, RECORDING_RETRY_DELAYS_MS) ?? new Date(nowMs + lastLeaseMs);
        await patchAsset(manager, asset.dateId, new Date(nowMs).toISOString(), {
          call_attempts: attempt,
          call_next_attempt_at: next.toISOString(),
        });
        claimed.push({ asset, attempt });
      }
      return claimed;
    });
  }

  private async attempt(asset: LockedAsset, attempt: number): Promise<void> {
    const call = callDue(asset);
    if (call === null) return;
    let result: CallResult;
    try {
      result = await this.invoke(call, asset);
    } catch (error) {
      this.logger.warn(
        `date ${asset.dateId}: the recording's ${call} call failed, attempt ${String(attempt)}: ${nameOf(error)}`,
      );
      if (error instanceof CallRefused || attempt >= RECORDING_ATTEMPTS_MAX) {
        await this.giveUp(asset.dateId, call, attempt);
      }
      // Otherwise the claim already scheduled the next attempt.
      return;
    }
    let orphan: RecordingRef | null;
    try {
      orphan = await this.dataSource.transaction((manager) => this.settle(manager, asset, result));
    } catch (error) {
      if (error instanceof CallRefused) {
        await this.giveUp(asset.dateId, call, attempt);
        return;
      }
      this.logger.error(
        `date ${asset.dateId}: the recording's ${call} call answered, its outcome not written: ${nameOf(error)}`,
      );
      orphan = result.call === RecordingCall.START ? result.ref : null;
    }
    if (orphan !== null) await this.deleteOrphan(asset.dateId, orphan);
  }

  private async invoke(call: RecordingCall, asset: LockedAsset): Promise<CallResult> {
    const { recordingRef: ref } = asset;
    switch (call) {
      case RecordingCall.START: {
        const run = await readRunFacts(this.dataSource.manager, asset.dateId);
        if (run === null) throw new Error('the asset has no run');
        return { call, ref: await this.started(asset.dateId, run.streamPath) };
      }
      case RecordingCall.STOP:
        if (ref !== null) await ignoringUnknown(() => this.provider.stop(ref));
        return { call };
      case RecordingCall.STATUS: {
        if (ref === null) throw new CallRefused();
        try {
          return { call, status: await withinTimeout(this.provider.status(ref)) };
        } catch (error) {
          throw error instanceof RecordingNotFound ? new CallRefused() : error;
        }
      }
      case RecordingCall.DELETE:
        if (ref !== null) await ignoringUnknown(() => this.provider.delete(ref));
        return { call };
    }
  }

  /** A start answering after its timeout has still started a recording, which nobody will keep. */
  private async started(dateId: string, streamPath: string): Promise<RecordingRef> {
    const starting = this.provider.start(streamPath);
    try {
      return await withinTimeout(starting);
    } catch (error) {
      if (error instanceof RecordingCallTimedOut) {
        void starting.then(
          (late) => this.deleteOrphan(dateId, late),
          () => undefined,
        );
      }
      throw error;
    }
  }

  /**
   * The outcome of a call, written in a transaction of its own after deciding again on the locked
   *   row. A recording started that the asset does not keep comes back, to be deleted once committed.
   */
  private async settle(
    manager: EntityManager,
    asked: LockedAsset,
    result: CallResult,
  ): Promise<RecordingRef | null> {
    const now = this.clock.now();
    const asset = await lockAssetWaiting(manager, asked.dateId);
    if (result.call === RecordingCall.START) {
      return this.settleStart(manager, asset, result.ref, now);
    }
    if (asset === null || callDue(asset) !== result.call) return null;
    switch (result.call) {
      case RecordingCall.STOP:
        await patchAsset(manager, asset.dateId, now, { stopped_at: now, ...CALL_DUE_NOW });
        break;
      case RecordingCall.DELETE:
        await patchAsset(manager, asset.dateId, now, {
          state: ReplayAssetState.DELETED,
          deleted_at: now,
          recording_ref: null,
          ...CALL_DUE_NOW,
        });
        break;
      case RecordingCall.STATUS:
        await this.settleStatus(manager, asset, result.status, now);
        break;
    }
    return null;
  }

  /** The reference kept, or back when the asset moved on while the provider started. */
  private async settleStart(
    manager: EntityManager,
    asset: LockedAsset | null,
    ref: RecordingRef,
    now: string,
  ): Promise<RecordingRef | null> {
    if (
      asset?.recordingRef === null &&
      (asset.state === ReplayAssetState.RECORDING || asset.state === ReplayAssetState.DELETING)
    ) {
      await patchAsset(manager, asset.dateId, now, { recording_ref: ref, ...CALL_DUE_NOW });
      return null;
    }
    return ref;
  }

  /** Never inside a transaction: the provider is called once the asset's outcome is committed. */
  private async deleteOrphan(dateId: string, ref: RecordingRef): Promise<void> {
    for (let attempt = 1; attempt <= ORPHAN_DELETE_ATTEMPTS; attempt += 1) {
      try {
        await withinTimeout(this.provider.delete(ref));
        this.logger.error(
          `date ${dateId}: a recording started that the asset did not keep, deleted`,
        );
        return;
      } catch (error) {
        this.logger.warn(
          `date ${dateId}: deleting a recording the asset did not keep failed, attempt ${String(attempt)}: ${nameOf(error)}`,
        );
      }
    }
    this.logger.error(
      `date ${dateId}: a recording started that the asset did not keep is left at the provider`,
    );
  }

  private async settleStatus(
    manager: EntityManager,
    asset: LockedAsset,
    status: RecordingStatus,
    now: string,
  ): Promise<void> {
    if (!status.ready || status.durationSec === null) {
      const giveUpAt = new Date(
        toEpochMs(asset.recordedUntil ?? now) + READINESS_GIVE_UP_AFTER_MS,
      ).toISOString();
      if (!isAfter(giveUpAt, now)) throw new CallRefused();
      await patchAsset(manager, asset.dateId, now, {
        call_attempts: 0,
        call_next_attempt_at: new Date(toEpochMs(now) + READINESS_POLL_EVERY_MS).toISOString(),
      });
      return;
    }
    const facts = await readDateFacts(manager, asset.dateId);
    const run = await readRunFacts(manager, asset.dateId);
    if (facts?.timing == null || run?.endedAt == null) {
      throw new Error('the date or its run is not projected: the readiness waits');
    }
    const readiness = readinessAt(now, run.endedAt, {
      timing: facts.timing,
      outcome: facts.outcome,
    });
    if (readiness.kind === 'withdrawn') {
      await patchAsset(manager, asset.dateId, now, {
        state: ReplayAssetState.DELETING,
        ...CALL_DUE_NOW,
      });
      return;
    }
    await writeAssetReady(
      manager,
      {
        dateId: asset.dateId,
        channelId: asset.channelId,
        durationSec: status.durationSec,
        availableFrom: readiness.availableFrom,
        expiresAt: readiness.expiresAt,
      },
      now,
    );
    await patchAsset(manager, asset.dateId, now, {
      state: ReplayAssetState.READY,
      duration_sec: status.durationSec,
      available_from: readiness.availableFrom,
      expires_at: readiness.expiresAt,
      announced_at: now,
      ...CALL_DUE_NOW,
    });
  }

  /** The call refused for good or out of attempts: the asset is `failed`, kept, with the call's name. */
  private async giveUp(dateId: string, call: RecordingCall, attempt: number): Promise<void> {
    const now = this.clock.now();
    const marked = await this.dataSource.transaction(async (manager) => {
      const asset = await lockAssetWaiting(manager, dateId);
      if (asset === null || callDue(asset) !== call) return false;
      await patchAsset(manager, dateId, now, {
        state: ReplayAssetState.FAILED,
        call_dead_at: now,
        call_next_attempt_at: null,
        failed_call: call,
      });
      return true;
    });
    if (marked) {
      this.logger.error(
        `date ${dateId}: the recording's ${call} call given up after ${String(attempt)} attempts`,
      );
    }
  }
}

/** The losing call keeps running: the port takes no signal to abort it. */
export async function withinTimeout<T>(
  call: Promise<T>,
  timeoutMs: number = RECORDING_CALL_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RecordingCallTimedOut());
    }, timeoutMs);
  });
  try {
    return await Promise.race([call, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function ignoringUnknown(call: () => Promise<void>): Promise<void> {
  try {
    await withinTimeout(call());
  } catch (error) {
    if (!(error instanceof RecordingNotFound)) throw error;
  }
}

/** A provider's message may carry the reference: only the error's name is logged. */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
