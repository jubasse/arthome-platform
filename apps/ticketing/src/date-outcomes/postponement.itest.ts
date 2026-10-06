import { Outcome } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FixedClock,
  SeatCancelReason,
  SeatState,
  plusMinutes,
  seatCancelDeadline,
} from '@arthome/core';

import { CLOCK } from '../clock.js';
import { ApplyCatalogDateFactHandler } from '../date-sales/apply-catalog-date-fact.handler.js';
import { applyCatalogDateMessage } from '../date-sales/catalog-date-messages.js';
import { OpenCapacityTierHandler } from '../date-sales/open-capacity-tier.handler.js';
import { SetDatePricesHandler } from '../date-sales/set-date-prices.handler.js';
import { delivered, rescheduled } from '../itest/catalog-messages.js';
import { seedPaidOrders } from '../itest/paid-orders.js';
import { putOnSale } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/**
 * A postponement (adr-ticketing.md §8, HANDOVER §0n): the seats follow, their cancel deadline
 *   recomputed from the new start by one statement run before the date's row is locked, and a
 *   start that lost to a newer one moves none.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const NOW = '2026-10-01T10:00:00.000Z';
const STARTS_AT = '2026-12-12T19:00:00.000Z';
const CHANNEL = '01a0e20c-0000-7000-8000-000000000001';
const ACCOUNT = '01a0e2aa-0000-7000-8000-000000000001';

let stack: StartedStack;
let dataSource: DataSource;
let cqrs: TestingModule;
let commands: CommandBus;
let dates = 0;

async function dateWithSeats(quantities: readonly number[]): Promise<string> {
  dates += 1;
  const dateId = `01a0e200-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await putOnSale(commands, { dateId, channelId: CHANNEL, capacity: 10, startsAt: STARTS_AT }, NOW);
  await seedPaidOrders(dataSource, {
    dateId,
    channelId: CHANNEL,
    series: `01a0e2${String(dates).padStart(2, '0')}`,
    quantities,
    accountId: ACCOUNT,
    cancelDeadline: seatCancelDeadline(STARTS_AT),
    paidAt: NOW,
  });
  return dateId;
}

async function deadlinesOf(dateId: string): Promise<Record<string, number>> {
  const rows = await dataSource.query<{ state: string; deadline: Date; seats: number }[]>(
    `SELECT state, cancel_deadline AS deadline, count(*)::int AS seats FROM seat
      WHERE date_id = $1 GROUP BY state, cancel_deadline`,
    [dateId],
  );
  return Object.fromEntries(
    rows.map(({ state, deadline, seats }) => [`${state} ${deadline.toISOString()}`, seats]),
  );
}

function postponed(dateId: string, startsAt: string, statedAt: string) {
  return delivered(rescheduled(dateId, startsAt, statedAt));
}

async function whileStatementSleeps(work: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 5_000;
  let sleeping = 0;
  while (sleeping === 0 && Date.now() < deadline) {
    const [row] = await dataSource.query<{ sleeping: number }[]>(
      `SELECT count(*)::int AS sleeping FROM pg_stat_activity
        WHERE wait_event = 'PgSleep' AND datname = current_database()`,
    );
    sleeping = row?.sleeping ?? 0;
  }
  expect(sleeping).toBe(1);
  await work();
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_postponement_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  cqrs = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      TicketingTransactions,
      ApplyCatalogDateFactHandler,
      OpenCapacityTierHandler,
      SetDatePricesHandler,
      { provide: DataSource, useValue: dataSource },
      { provide: CLOCK, useValue: new FixedClock(NOW) },
    ],
  }).compile();
  await cqrs.init();
  commands = cqrs.get(CommandBus);
}, STARTUP_MS);

afterAll(async () => {
  await cqrs?.close();
  await dataSource?.destroy();
  await stack?.stop();
});

describe('a postponement', () => {
  it(
    "moves 10,000 active seats' deadlines with the start in one statement, and no other seat",
    async () => {
      const dateId = await dateWithSeats(Array.from({ length: 2_500 }, () => 4));
      const otherDateId = await dateWithSeats([1]);
      const [, cancelled] = await dataSource.query<[unknown[], number]>(
        `UPDATE seat SET state = $2, ended_at = $3, cancel_reason = $4
          WHERE id = (SELECT id FROM seat WHERE date_id = $1 ORDER BY id LIMIT 1)`,
        [dateId, SeatState.CANCELLED, new Date(NOW), SeatCancelReason.VIEWER_REQUEST],
      );
      expect(cancelled).toBe(1);
      await dataSource.query('CREATE TABLE itest_seat_statements (n integer NOT NULL)');
      await dataSource.query(`
        CREATE FUNCTION itest_count_seat_statement() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO itest_seat_statements VALUES (1); RETURN NULL; END $$`);
      await dataSource.query(`
        CREATE TRIGGER itest_count_seat_statement AFTER UPDATE ON seat
        FOR EACH STATEMENT EXECUTE FUNCTION itest_count_seat_statement()`);
      const movedTo = '2026-12-19T19:00:00.000Z';
      try {
        expect(
          await applyCatalogDateMessage(commands, postponed(dateId, movedTo, plusMinutes(NOW, 1))),
        ).toBe(Outcome.APPLIED);

        const [statements] = await dataSource.query<{ n: number }[]>(
          'SELECT count(*)::int AS n FROM itest_seat_statements',
        );
        expect(statements?.n).toBe(1);
      } finally {
        await dataSource.query('DROP TRIGGER itest_count_seat_statement ON seat');
        await dataSource.query('DROP FUNCTION itest_count_seat_statement()');
        await dataSource.query('DROP TABLE itest_seat_statements');
      }
      expect(await deadlinesOf(dateId)).toEqual({
        [`${SeatState.ACTIVE} ${seatCancelDeadline(movedTo)}`]: 9_999,
        [`${SeatState.CANCELLED} ${seatCancelDeadline(STARTS_AT)}`]: 1,
      });
      expect(await deadlinesOf(otherDateId)).toEqual({
        [`${SeatState.ACTIVE} ${seatCancelDeadline(STARTS_AT)}`]: 1,
      });
    },
    CASE_MS,
  );

  it(
    "leaves the date's row free while it moves the seats: a hold on the date does not wait",
    async () => {
      const dateId = await dateWithSeats([2, 2]);
      await dataSource.query(`
        CREATE FUNCTION itest_slow_seat_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(1); RETURN NULL; END $$`);
      await dataSource.query(`
        CREATE TRIGGER itest_slow_seat_update BEFORE UPDATE ON seat
        FOR EACH STATEMENT EXECUTE FUNCTION itest_slow_seat_update()`);
      try {
        const moving = applyCatalogDateMessage(
          commands,
          postponed(dateId, '2026-12-19T19:00:00.000Z', plusMinutes(NOW, 1)),
        );
        let waited: unknown = null;
        await whileStatementSleeps(async () => {
          const runner = dataSource.createQueryRunner();
          await runner.connect();
          try {
            await runner.startTransaction();
            await runner.query("SET LOCAL lock_timeout = '200ms'");
            await runner.query(
              `UPDATE date_sales
                  SET seats_available = seats_available - 1,
                      availability_moves = availability_moves + 1
                WHERE date_id = $1 AND on_sale AND seats_available >= 1`,
              [dateId],
            );
          } catch (error) {
            waited = error;
          } finally {
            await runner.rollbackTransaction();
            await runner.release();
          }
        });
        expect(await moving).toBe(Outcome.APPLIED);
        expect(waited).toBeNull();
      } finally {
        await dataSource.query('DROP TRIGGER itest_slow_seat_update ON seat');
        await dataSource.query('DROP FUNCTION itest_slow_seat_update()');
      }
    },
    CASE_MS,
  );

  it(
    'moves none for a start older than the one applied, superseded',
    async () => {
      const dateId = await dateWithSeats([1, 3]);
      const newer = '2026-12-26T19:00:00.000Z';
      await applyCatalogDateMessage(commands, postponed(dateId, newer, plusMinutes(NOW, 2)));

      expect(
        await applyCatalogDateMessage(
          commands,
          postponed(dateId, '2026-12-19T19:00:00.000Z', plusMinutes(NOW, 1)),
        ),
      ).toBe(Outcome.SUPERSEDED);
      expect(await deadlinesOf(dateId)).toEqual({
        [`${SeatState.ACTIVE} ${seatCancelDeadline(newer)}`]: 4,
      });
    },
    CASE_MS,
  );

  it(
    'rolls back the seats it moved when a newer start commits before its lock, then is superseded',
    async () => {
      const dateId = await dateWithSeats([2, 1]);
      const newerStart = '2026-12-26T19:00:00.000Z';
      const message = postponed(dateId, '2026-12-19T19:00:00.000Z', plusMinutes(NOW, 1));
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      await runner.query(
        `UPDATE date_sales SET starts_at = $2, schedule_stated_at = $3, version = version + 1
          WHERE date_id = $1`,
        [dateId, new Date(newerStart), new Date(plusMinutes(NOW, 2))],
      );
      const refusal = applyCatalogDateMessage(commands, message).then(
        () => null,
        (error: unknown) => error,
      );
      try {
        const deadline = Date.now() + 5_000;
        let blocked = 0;
        while (blocked === 0 && Date.now() < deadline) {
          const [row] = await dataSource.query<{ blocked: number }[]>(
            `SELECT count(*)::int AS blocked FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND datname = current_database()`,
          );
          blocked = row?.blocked ?? 0;
        }
        expect(blocked).toBe(1);
        await runner.commitTransaction();
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
      }

      expect(String(await refusal)).toMatch(/overtaken while its 3 seats moved/);
      expect(await deadlinesOf(dateId)).toEqual({
        [`${SeatState.ACTIVE} ${seatCancelDeadline(STARTS_AT)}`]: 3,
      });
      expect(await applyCatalogDateMessage(commands, message)).toBe(Outcome.SUPERSEDED);
      expect(await deadlinesOf(dateId)).toEqual({
        [`${SeatState.ACTIVE} ${seatCancelDeadline(STARTS_AT)}`]: 3,
      });
    },
    CASE_MS,
  );
});
