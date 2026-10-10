import { updateReturning } from '@arthome-platform/transactions';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Command, CommandBus, CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import type { Clock } from '@arthome/core';

import { EXPIRE_LAPSED_SQL } from './playback-sessions.js';
import { CLOCK } from '../clock.js';
import { SweeperLoop } from '../sweeper-loop.js';

export const LEASE_SWEEP_BATCH = 500;

const LEASE_SWEEP_EVERY_MS = 5_000;

/** Marks lapsed leases `expired`. No decision depends on it: every count reads the lease's expiry. */
export class ExpireLapsedLeases extends Command<number> {
  public constructor(public readonly batch: number = LEASE_SWEEP_BATCH) {
    super();
  }
}

/** One statement, `SKIP LOCKED`: replicas share the due rows, and an opening's locked rows wait. */
@CommandHandler(ExpireLapsedLeases)
export class ExpireLapsedLeasesHandler implements ICommandHandler<ExpireLapsedLeases> {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async execute({ batch }: ExpireLapsedLeases): Promise<number> {
    const expired = await updateReturning<{ id: string }>(this.dataSource, EXPIRE_LAPSED_SQL, [
      new Date(this.clock.now()),
      batch,
    ]);
    return expired.length;
  }
}

@Injectable()
export class PlaybackLeaseSweeper extends SweeperLoop {
  protected readonly logger = new Logger(PlaybackLeaseSweeper.name);

  public constructor(private readonly commands: CommandBus) {
    super(LEASE_SWEEP_EVERY_MS, LEASE_SWEEP_BATCH);
  }

  protected pass(): Promise<number> {
    return this.commands.execute(new ExpireLapsedLeases());
  }
}
