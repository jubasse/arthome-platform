import {
  CreditIssuedSchema,
  CreditOrigin as WireCreditOrigin,
  DateOutcome as WireDateOutcome,
} from '@arthome-platform/events';
import { Outcome } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CreditOrigin,
  CreditState,
  FixedClock,
  OrderState,
  RefundReason,
  SeatState,
  creditExpiresAt,
  seatCancelDeadline,
} from '@arthome/core';

import { SettleDateOutcomes } from './settle-date-outcomes.command.js';
import { SettleDateOutcomesHandler } from './settle-date-outcomes.handler.js';
import { NoWaitlistOutcomeHook, WaitlistOutcomeHook } from './waitlist-outcome-hook.js';
import { CLOCK } from '../clock.js';
import { ApplyCatalogDateFactHandler } from '../date-sales/apply-catalog-date-fact.handler.js';
import { applyCatalogDateMessage } from '../date-sales/catalog-date-messages.js';
import { OpenCapacityTierHandler } from '../date-sales/open-capacity-tier.handler.js';
import { SetDatePricesHandler } from '../date-sales/set-date-prices.handler.js';
import { delivered, outcomeDeclared } from '../itest/catalog-messages.js';
import { seedPaidOrders, seededOrderId } from '../itest/paid-orders.js';
import { FULL_PRICE_MINOR, putOnSale } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/**
 * An interrupted date settled (adr-ticketing.md §8, HANDOVER §0n): one credit note per paid order
 *   for what is left of it, on its channel and valid twelve months, written 500 orders per
 *   transaction with `credit.issued` on the account's key; its seats credited, nothing cancelled.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 180_000;

const NOW = '2026-10-03T20:00:00.000Z';
const STARTS_AT = '2026-10-03T19:00:00.000Z';
const CHANNEL = '01a0e40c-0000-7000-8000-000000000001';
const ACCOUNT = '01a0e4aa-0000-7000-8000-000000000001';
const DATE_ID = '01a0e400-0000-7000-8000-000000000001';
const CREDITED = '01a0e401';
const WITHOUT_ACCOUNT = '01a0e402';
const REFUNDED_IN_FULL = '01a0e403';
const ORDERS = 1_200;

let stack: StartedStack;
let dataSource: DataSource;
let cqrs: TestingModule;
let commands: CommandBus;

const quantityOf = (n: number): number => (n % 5 === 0 ? 3 : 1);
const settle = (): Promise<number> => commands.execute(new SettleDateOutcomes());

async function creditCount(): Promise<number> {
  const [row] = await dataSource.query<{ credits: number }[]>(
    'SELECT count(*)::int AS credits FROM credit',
  );
  return row?.credits ?? 0;
}

async function seatsOf(series: string) {
  return dataSource.query<{ state: string; credit_id: string | null }[]>(
    'SELECT state, credit_id FROM seat WHERE order_id = $1',
    [seededOrderId(series, 1)],
  );
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_interrupted_date_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  cqrs = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      TicketingTransactions,
      ApplyCatalogDateFactHandler,
      OpenCapacityTierHandler,
      SetDatePricesHandler,
      SettleDateOutcomesHandler,
      { provide: WaitlistOutcomeHook, useClass: NoWaitlistOutcomeHook },
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

describe('an interrupted date', () => {
  it(
    'credits each paid order what is left, in batches of 500, on its account and channel',
    async () => {
      await putOnSale(
        commands,
        { dateId: DATE_ID, channelId: CHANNEL, capacity: 10, startsAt: STARTS_AT },
        NOW,
      );
      const seeded = {
        dateId: DATE_ID,
        channelId: CHANNEL,
        cancelDeadline: seatCancelDeadline(STARTS_AT),
        paidAt: NOW,
      };
      const orderIds = await seedPaidOrders(dataSource, {
        ...seeded,
        series: CREDITED,
        quantities: Array.from({ length: ORDERS }, (_, index) => quantityOf(index + 1)),
        accountId: ACCOUNT,
      });
      await seedPaidOrders(dataSource, {
        ...seeded,
        series: WITHOUT_ACCOUNT,
        quantities: [2],
        accountId: null,
      });
      const [refundedInFull] = await seedPaidOrders(dataSource, {
        ...seeded,
        series: REFUNDED_IN_FULL,
        quantities: [2],
        accountId: ACCOUNT,
      });
      await dataSource.query(
        `INSERT INTO order_refund (id, order_id, amount_minor, currency_code, reason,
                                   idempotency_key, owed_at, refund_ref, refunded_at)
         VALUES ('01a0e4ff-0000-7000-8000-000000000001', $1, $2, 'EUR', $3,
                 'refund:01a0e4ff-0000-7000-8000-000000000001', $4, 're_goodwill', $4)`,
        [refundedInFull, 2 * FULL_PRICE_MINOR, RefundReason.GOODWILL, new Date(NOW)],
      );
      await dataSource.query('UPDATE seat_order SET state = $2 WHERE id = $1', [
        refundedInFull,
        OrderState.REFUNDED,
      ]);

      expect(
        await applyCatalogDateMessage(
          commands,
          delivered(outcomeDeclared(DATE_ID, WireDateOutcome.INTERRUPTED, NOW)),
        ),
      ).toBe(Outcome.APPLIED);
      const batches = [await settle(), await settle(), await settle(), await settle()];

      expect(batches).toEqual([500, 500, 202, 0]);
      const [settlement] = await dataSource.query<{ settled: boolean }[]>(
        `SELECT settled_at IS NOT NULL AS settled FROM date_outcome_settlement
          WHERE date_id = $1`,
        [DATE_ID],
      );
      expect(settlement?.settled).toBe(true);

      const credits = await dataSource.query<
        {
          id: string;
          account_id: string;
          channel_id: string;
          order_id: string;
          amount_minor: string;
          currency_code: string;
          origin: string;
          origin_ref: string;
          state: string;
          expires_at: Date;
        }[]
      >('SELECT * FROM credit');
      expect(credits).toHaveLength(ORDERS);
      for (const credit of credits) {
        const n = orderIds.indexOf(credit.order_id) + 1;
        expect(n).toBeGreaterThan(0);
        expect(credit).toMatchObject({
          account_id: ACCOUNT,
          channel_id: CHANNEL,
          amount_minor: String(FULL_PRICE_MINOR * quantityOf(n)),
          currency_code: 'EUR',
          origin: CreditOrigin.INTERRUPTED_DATE,
          origin_ref: DATE_ID,
          state: CreditState.ISSUED,
          expires_at: new Date(creditExpiresAt(NOW)),
        });
      }

      const seats = await dataSource.query<
        { order_id: string; state: string; credit_id: string | null; credited: string | null }[]
      >(
        `SELECT order_id, state, credit_id, credit_amount_minor AS credited FROM seat
          WHERE order_id = ANY($1)`,
        [orderIds],
      );
      const creditOf = new Map(credits.map((credit) => [credit.order_id, credit]));
      const creditedPerOrder = new Map<string, number>();
      for (const seat of seats) {
        expect(seat.state).toBe(SeatState.CREDITED);
        expect(seat.credit_id).toBe(creditOf.get(seat.order_id)?.id);
        creditedPerOrder.set(
          seat.order_id,
          (creditedPerOrder.get(seat.order_id) ?? 0) + Number(seat.credited),
        );
      }
      for (const credit of credits) {
        expect(creditedPerOrder.get(credit.order_id)).toBe(Number(credit.amount_minor));
      }

      const issued = await dataSource.query<
        { aggregatetype: string; aggregateid: string; payload: Buffer }[]
      >(
        `SELECT aggregatetype, aggregateid, payload FROM outbox_event
          WHERE type = 'ticketing.credit.issued.v1'`,
      );
      expect(issued).toHaveLength(ORDERS);
      const issuedIds = new Set<string>();
      for (const { aggregatetype, aggregateid, payload } of issued) {
        expect(aggregatetype).toBe('ticketing.account');
        expect(aggregateid).toBe(ACCOUNT);
        const event = fromBinary(CreditIssuedSchema, payload);
        expect(event).toMatchObject({
          accountId: ACCOUNT,
          channelId: CHANNEL,
          origin: WireCreditOrigin.INTERRUPTED_DATE,
          originDateId: DATE_ID,
        });
        expect(event.expiresAt && timestampDate(event.expiresAt).toISOString()).toBe(
          creditExpiresAt(NOW),
        );
        const credit = credits.find(({ id }) => id === event.creditId);
        expect(event.amount?.amountMinor).toBe(BigInt(credit?.amount_minor ?? -1));
        issuedIds.add(event.creditId);
      }
      expect(issuedIds.size).toBe(ORDERS);
      const [cancelled] = await dataSource.query<{ events: number }[]>(
        `SELECT count(*)::int AS events FROM outbox_event
          WHERE type = 'ticketing.seat.cancelled.v1'`,
      );
      expect(cancelled?.events).toBe(0);

      expect(await seatsOf(WITHOUT_ACCOUNT)).toEqual([
        { state: SeatState.ACTIVE, credit_id: null },
        { state: SeatState.ACTIVE, credit_id: null },
      ]);
      expect(await seatsOf(REFUNDED_IN_FULL)).toEqual([
        { state: SeatState.ACTIVE, credit_id: null },
        { state: SeatState.ACTIVE, credit_id: null },
      ]);
    },
    CASE_MS,
  );

  it(
    'issues nothing on a second pass, nor on an order whose credit was issued already',
    async () => {
      const orderId = seededOrderId(CREDITED, 1);
      await dataSource.query(
        `UPDATE seat SET state = $2, ended_at = NULL, credit_id = NULL, credit_amount_minor = NULL
          WHERE order_id = $1`,
        [orderId, SeatState.ACTIVE],
      );
      await dataSource.query('UPDATE seat_order SET outcome_settled_at = NULL WHERE id = $1', [
        orderId,
      ]);
      await dataSource.query(
        'UPDATE date_outcome_settlement SET settled_at = NULL WHERE date_id = $1',
        [DATE_ID],
      );

      expect(await settle()).toBe(1);
      expect(await settle()).toBe(0);
      expect(await creditCount()).toBe(ORDERS);
      const [issued] = await dataSource.query<{ events: number }[]>(
        `SELECT count(*)::int AS events FROM outbox_event
          WHERE type = 'ticketing.credit.issued.v1'`,
      );
      expect(issued?.events).toBe(ORDERS);
    },
    CASE_MS,
  );

  it(
    'credits a seat a share of nothing when the credit has fewer minor units than seats',
    async () => {
      const dateId = '01a0e400-0000-7000-8000-000000000002';
      await putOnSale(commands, { dateId, channelId: CHANNEL, capacity: 10 }, NOW);
      const [orderId] = await seedPaidOrders(dataSource, {
        dateId,
        channelId: CHANNEL,
        series: '01a0e404',
        quantities: [3],
        accountId: ACCOUNT,
        cancelDeadline: null,
        paidAt: NOW,
      });
      await dataSource.query(
        `INSERT INTO order_refund (id, order_id, amount_minor, currency_code, reason,
                                   idempotency_key, owed_at, refund_ref, refunded_at)
         VALUES ('01a0e4ff-0000-7000-8000-000000000002', $1, $2, 'EUR', $3,
                 'refund:01a0e4ff-0000-7000-8000-000000000002', $4, 're_goodwill', $4)`,
        [orderId, 3 * FULL_PRICE_MINOR - 2, RefundReason.GOODWILL, new Date(NOW)],
      );
      await dataSource.query('UPDATE seat_order SET state = $2 WHERE id = $1', [
        orderId,
        OrderState.PARTIALLY_REFUNDED,
      ]);
      await applyCatalogDateMessage(
        commands,
        delivered(outcomeDeclared(dateId, WireDateOutcome.INTERRUPTED, NOW)),
      );

      expect(await settle()).toBe(1);
      const seats = await dataSource.query<{ state: string; credited: string }[]>(
        `SELECT state, credit_amount_minor AS credited FROM seat WHERE order_id = $1
          ORDER BY id`,
        [orderId],
      );
      expect(seats).toEqual([
        { state: SeatState.CREDITED, credited: '1' },
        { state: SeatState.CREDITED, credited: '1' },
        { state: SeatState.CREDITED, credited: '0' },
      ]);
    },
    CASE_MS,
  );
});
