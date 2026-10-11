import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Command, CommandBus, CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  HOLD_SCREEN_AUTO_AFTER_SECONDS_DEFAULT,
  PUBLISHER_GRACE_SECONDS,
  RunState,
  endsAt,
  isAfter,
  plusSeconds,
  runAutoEndsAt,
  type Clock,
} from '@arthome/core';

import { READ_DATE_FACTS, type ReadDateFacts } from './date-facts.js';
import { recordRunEvents } from './record-run-events.js';
import { CLOCK } from '../clock.js';
import { StreamingTransactions } from '../streaming-transactions.js';
import { SweeperLoop } from '../sweeper-loop.js';

export const RUN_PASS_BATCH = 100;

const RUN_PASS_EVERY_MS = 1_000;

/** Through `idx_run_publisher_lost`: $1 the grace's bound, $2 the hold screen's, $3 the batch. */
export const PRESENCE_DUE_SQL = `
  SELECT id FROM run
   WHERE state = '${RunState.ON_AIR}' AND publisher_online_since IS NULL
     AND publisher_lost_at <= $1
     AND (NOT after_grace_period OR publisher_lost_at <= $2)
   ORDER BY publisher_lost_at
   LIMIT $3`;

/** Through `run_live`, which PS5's recording pass reads too: $1 the page's last date, $2 its size. */
export const LIVE_RUNS_SQL = `
  SELECT id, date_id, publisher_lost_at FROM run
   WHERE state IN ('${RunState.ON_AIR}', '${RunState.INTERRUPTED}')
     AND publisher_online_since IS NULL
     AND ($1::uuid IS NULL OR date_id > $1)
   ORDER BY date_id
   LIMIT $2`;

/** The publisher's loss on air: "publisher gone" past the grace, the hold screen at its delay. */
export class SweepRunPresence extends Command<number> {
  public constructor(public readonly batch: number = RUN_PASS_BATCH) {
    super();
  }
}

/** D-123: the runs left on air that end by themselves. */
export class EndRunsByThemselves extends Command<number> {
  public constructor(public readonly batch: number = RUN_PASS_BATCH) {
    super();
  }
}

/*
 * Both passes read their candidates without a lock, through their partial index, then take each
 *   run in a short transaction of its own, `FOR UPDATE SKIP LOCKED`, and decide again on what they
 *   locked (ticketing HANDOVER §0e): every replica may run them, and none handles a run twice.
 */

@CommandHandler(SweepRunPresence)
export class SweepRunPresenceHandler implements ICommandHandler<SweepRunPresence> {
  public constructor(
    private readonly transactions: StreamingTransactions,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public async execute({ batch }: SweepRunPresence): Promise<number> {
    const now = this.clock.now();
    const due = await this.dataSource.query<{ id: string }[]>(PRESENCE_DUE_SQL, [
      new Date(plusSeconds(now, -PUBLISHER_GRACE_SECONDS)),
      new Date(plusSeconds(now, -HOLD_SCREEN_AUTO_AFTER_SECONDS_DEFAULT)),
      batch,
    ]);
    let settled = 0;
    for (const { id } of due) {
      const moved = await this.transactions.run(async ({ manager, runs }) => {
        const run = await runs.claim(id);
        if (run === null) return false;
        const gone = run.declarePublisherGone(now);
        const veiled = run.raiseHoldScreenIfFeedLost(randomUUID(), now);
        if (!gone && !veiled) return false;
        await runs.save(run);
        await recordRunEvents(manager, run.getUncommittedEvents(), null);
        return true;
      });
      if (moved) settled += 1;
    }
    return settled;
  }
}

interface LiveRun {
  readonly id: string;
  readonly date_id: string;
  readonly publisher_lost_at: Date | null;
}

/**
 * Reads every live run with no publisher, page by page: they are as many as the lives under way,
 *   and a run not due yet must not hold a due one out of a batch. A date with no timing never ends
 *   by itself; it is logged once per run and process.
 */
@CommandHandler(EndRunsByThemselves)
export class EndRunsByThemselvesHandler implements ICommandHandler<EndRunsByThemselves> {
  private readonly logger = new Logger(EndRunsByThemselvesHandler.name);
  private readonly loggedWithoutTiming = new Set<string>();

  public constructor(
    private readonly transactions: StreamingTransactions,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(READ_DATE_FACTS) private readonly readDateFacts: ReadDateFacts,
  ) {}

  public async execute({ batch }: EndRunsByThemselves): Promise<number> {
    const now = this.clock.now();
    let ended = 0;
    let after: string | null = null;
    for (;;) {
      const live: LiveRun[] = await this.dataSource.query<LiveRun[]>(LIVE_RUNS_SQL, [after, batch]);
      for (const candidate of live) {
        if (await this.endIfDue(candidate, now)) ended += 1;
      }
      const last = live.at(-1);
      if (last === undefined || live.length < batch) return ended;
      after = last.date_id;
    }
  }

  private async endIfDue(candidate: LiveRun, now: string): Promise<boolean> {
    const scheduledEnd = await this.scheduledEndOf(candidate);
    if (scheduledEnd === null) return false;
    const lostAt = candidate.publisher_lost_at?.toISOString() ?? null;
    const endsAtThen = runAutoEndsAt(scheduledEnd, lostAt, false);
    if (endsAtThen === null || isAfter(endsAtThen, now)) return false;
    return this.transactions.run(async ({ manager, runs }) => {
      const run = await runs.claim(candidate.id);
      const facts = await this.readDateFacts(manager, candidate.date_id);
      if (run === null || facts?.timing == null) return false;
      if (!run.endByItself(endsAt(facts.timing), now)) return false;
      await runs.save(run);
      await recordRunEvents(manager, run.getUncommittedEvents(), null);
      return true;
    });
  }

  private async scheduledEndOf({ id, date_id }: LiveRun): Promise<string | null> {
    const facts = await this.readDateFacts(this.dataSource.manager, date_id);
    if (facts?.timing == null) {
      if (!this.loggedWithoutTiming.has(id)) {
        this.loggedWithoutTiming.add(id);
        this.logger.warn(`run ${id}: its date has no timing projected, so it never ends by itself`);
      }
      return null;
    }
    return endsAt(facts.timing);
  }
}

@Injectable()
export class RunPresenceSweeper extends SweeperLoop {
  protected readonly logger = new Logger(RunPresenceSweeper.name);

  public constructor(private readonly commands: CommandBus) {
    super(RUN_PASS_EVERY_MS, RUN_PASS_BATCH);
  }

  protected pass(): Promise<number> {
    return this.commands.execute(new SweepRunPresence());
  }
}

@Injectable()
export class RunAutoEndSweeper extends SweeperLoop {
  protected readonly logger = new Logger(RunAutoEndSweeper.name);

  public constructor(private readonly commands: CommandBus) {
    // Its pass reads every candidate itself, so a full batch never asks for the next at once.
    super(RUN_PASS_EVERY_MS, Number.POSITIVE_INFINITY);
  }

  protected pass(): Promise<number> {
    return this.commands.execute(new EndRunsByThemselves());
  }
}
