import { Injectable, Logger, Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { RECORDING_CALLS_BATCH, RecordingCalls } from './recording-calls.js';
import { REPLAY_ASSET_PASS_BATCH, ReplayAssetPasses } from './replay-asset-passes.js';
import { CLOCK } from '../clock.js';
import { MediaModule } from '../media/media.module.js';
import { SweeperLoop } from '../sweeper-loop.js';

const REPLAY_ASSET_PASS_EVERY_MS = 1_000;

@Injectable()
export class RecordingRequestSweeper extends SweeperLoop {
  protected readonly logger = new Logger(RecordingRequestSweeper.name);

  public constructor(private readonly passes: ReplayAssetPasses) {
    // Its pass reads every candidate itself, so a full batch never asks for the next at once.
    super(REPLAY_ASSET_PASS_EVERY_MS, Number.POSITIVE_INFINITY);
  }

  protected pass(): Promise<number> {
    return this.passes.requestRecordings();
  }
}

@Injectable()
export class RecordingCloseSweeper extends SweeperLoop {
  protected readonly logger = new Logger(RecordingCloseSweeper.name);

  public constructor(private readonly passes: ReplayAssetPasses) {
    super(REPLAY_ASSET_PASS_EVERY_MS, REPLAY_ASSET_PASS_BATCH);
  }

  protected pass(): Promise<number> {
    return this.passes.closeRecordings();
  }
}

@Injectable()
export class ReplayWithdrawalSweeper extends SweeperLoop {
  protected readonly logger = new Logger(ReplayWithdrawalSweeper.name);

  public constructor(private readonly passes: ReplayAssetPasses) {
    super(REPLAY_ASSET_PASS_EVERY_MS, REPLAY_ASSET_PASS_BATCH);
  }

  protected pass(): Promise<number> {
    return this.passes.withdraw();
  }
}

@Injectable()
export class ReplayExpirySweeper extends SweeperLoop {
  protected readonly logger = new Logger(ReplayExpirySweeper.name);

  public constructor(private readonly passes: ReplayAssetPasses) {
    super(REPLAY_ASSET_PASS_EVERY_MS, REPLAY_ASSET_PASS_BATCH);
  }

  protected pass(): Promise<number> {
    return this.passes.expire();
  }
}

@Injectable()
export class RecordingCallSweeper extends SweeperLoop {
  protected readonly logger = new Logger(RecordingCallSweeper.name);

  public constructor(private readonly calls: RecordingCalls) {
    super(REPLAY_ASSET_PASS_EVERY_MS, RECORDING_CALLS_BATCH);
  }

  protected pass(): Promise<number> {
    return this.calls.pass();
  }
}

/** The replay asset's passes and provider calls in the sweeper process, on Postgres and the provider. */
@Module({
  imports: [MediaModule],
  providers: [
    { provide: CLOCK, useValue: new SystemClock() },
    ReplayAssetPasses,
    RecordingCalls,
    RecordingRequestSweeper,
    RecordingCloseSweeper,
    ReplayWithdrawalSweeper,
    ReplayExpirySweeper,
    RecordingCallSweeper,
  ],
})
export class ReplayAssetSweeperModule {}
