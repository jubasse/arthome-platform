import { RefusalException } from '@arthome-platform/http-edge';
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

import { FixedClock, MINUTE_MS, OrderErrorCode } from '@arthome/core';

import { SeatHoldState } from './commerce-vocabulary.js';
import { ExpireDueHolds } from './expire-due-holds.command.js';
import { ExpireDueHoldsHandler } from './expire-due-holds.handler.js';
import { PurchaseStatus, type PurchaseAnswer } from './purchase-seat.command.js';
import { PurchaseSeatHandler } from './purchase-seat.handler.js';
import { CLOCK } from '../clock.js';
import { ApplyCatalogDateFactHandler } from '../date-sales/apply-catalog-date-fact.handler.js';
import { OpenCapacityTierHandler } from '../date-sales/open-capacity-tier.handler.js';
import { SetDatePricesHandler } from '../date-sales/set-date-prices.handler.js';
import { purchaseOf, putOnSale } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { FakePaymentProvider, FakePaymentScenario } from '../payments/fake-payment-provider.js';
import { OwedRefunds } from '../payments/owed-refunds.js';
import { PaymentPort } from '../payments/payment.port.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/**
 * adr-ticketing.md §3's concurrency test, owed by the slice: many purchases at once on one date,
 *   well past its capacity, against a real Postgres whose pool runs ten of them at a time on the
 *   date's one row. The invariant is the conditional decrement alone: exactly the capacity held,
 *   never below zero, and every hold that expires given back. The load test at 10,000 buyers a
 *   minute is T6's.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 120_000;

const CHANNEL = '01a0ff0c-0000-7000-8000-000000000001';
const CAPACITY = 100;
const BUYERS = 300;

let stack: StartedStack;
let dataSource: DataSource;
let cqrs: TestingModule;
let commands: CommandBus;
let clock: FixedClock;
let fake: FakePaymentProvider;
let dates = 0;

interface Gauge {
  readonly seats_available: number;
  readonly seats_sold: number;
  readonly held: number;
  readonly active_holds: number;
}

async function gaugeOf(dateId: string): Promise<Gauge> {
  const [row] = await dataSource.query<Gauge[]>(
    `SELECT sales.seats_available, sales.seats_sold,
            coalesce(sum(hold.quantity) FILTER (WHERE hold.state = $2), 0)::int AS held,
            count(*) FILTER (WHERE hold.state = $2)::int AS active_holds
       FROM date_sales AS sales LEFT JOIN seat_hold AS hold USING (date_id)
      WHERE sales.date_id = $1
      GROUP BY sales.seats_available, sales.seats_sold`,
    [dateId, SeatHoldState.ACTIVE],
  );
  if (row === undefined) throw new Error(`no date ${dateId}`);
  return row;
}

async function dateOnSale(): Promise<string> {
  dates += 1;
  const dateId = `01a0ff00-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await putOnSale(commands, { dateId, channelId: CHANNEL, capacity: CAPACITY }, clock.now());
  return dateId;
}

type Outcome = PurchaseStatus | typeof OrderErrorCode.SOLD_OUT;

/** Every buyer at once, each answer or refusal counted: nothing else may come back. */
async function everyoneBuys(
  dateId: string,
  quantityOf: (buyer: number) => number,
): Promise<Map<Outcome, number>> {
  const outcomes = await Promise.all(
    Array.from({ length: BUYERS }, async (_, buyer): Promise<Outcome> => {
      try {
        const answer: PurchaseAnswer = await commands.execute(
          purchaseOf(dateId, quantityOf(buyer)),
        );
        return answer.status;
      } catch (error) {
        if (error instanceof RefusalException && error.refusal.code === OrderErrorCode.SOLD_OUT) {
          return OrderErrorCode.SOLD_OUT;
        }
        throw error;
      }
    }),
  );
  const counted = new Map<Outcome, number>();
  for (const outcome of outcomes) counted.set(outcome, (counted.get(outcome) ?? 0) + 1);
  return counted;
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_capacity_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  clock = new FixedClock('2026-09-28T10:00:00.000Z');
  fake = new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock);
  cqrs = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      TicketingTransactions,
      ApplyCatalogDateFactHandler,
      OpenCapacityTierHandler,
      SetDatePricesHandler,
      PurchaseSeatHandler,
      ExpireDueHoldsHandler,
      OwedRefunds,
      { provide: DataSource, useValue: dataSource },
      { provide: CLOCK, useValue: clock },
      { provide: PaymentPort, useValue: fake },
      { provide: PUBLIC_WEB_ORIGIN, useValue: 'http://storefront.test' },
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

describe('the capacity invariant under concurrent holds', () => {
  it(
    `holds exactly ${String(CAPACITY)} seats for ${String(BUYERS)} buyers at once, then gives every one back`,
    async () => {
      const dateId = await dateOnSale();
      fake.scenarioOf = () => FakePaymentScenario.REQUIRE_ACTION;

      const started = performance.now();
      const outcomes = await everyoneBuys(dateId, () => 1);
      const elapsedMs = performance.now() - started;

      expect(outcomes).toEqual(
        new Map<Outcome, number>([
          [PurchaseStatus.AWAITING_PAYMENT, CAPACITY],
          [OrderErrorCode.SOLD_OUT, BUYERS - CAPACITY],
        ]),
      );
      expect(await gaugeOf(dateId)).toEqual({
        seats_available: 0,
        seats_sold: 0,
        held: CAPACITY,
        active_holds: CAPACITY,
      });
      process.stdout.write(
        `${String(BUYERS)} purchases at once on one date: ${elapsedMs.toFixed(0)} ms
`,
      );

      clock.advance(15 * MINUTE_MS);
      let expired = 0;
      for (let pass = await commands.execute(new ExpireDueHolds()); pass > 0;) {
        expired += pass;
        pass = await commands.execute(new ExpireDueHolds());
      }

      expect(expired).toBe(CAPACITY);
      expect(await gaugeOf(dateId)).toEqual({
        seats_available: CAPACITY,
        seats_sold: 0,
        held: 0,
        active_holds: 0,
      });
    },
    CASE_MS,
  );

  it(
    'never goes below zero with quantities of one to three, paid or held: every seat accounted for',
    async () => {
      const dateId = await dateOnSale();
      fake.scenarioOf = ({ orderId }) =>
        orderId.charCodeAt(orderId.length - 1) % 2 === 0
          ? FakePaymentScenario.CONFIRM
          : FakePaymentScenario.REQUIRE_ACTION;

      const outcomes = await everyoneBuys(dateId, (buyer) => (buyer % 3) + 1);

      const gauge = await gaugeOf(dateId);
      expect(gauge.seats_available).toBeGreaterThanOrEqual(0);
      expect(gauge.seats_available).toBeLessThan(3);
      expect(gauge.seats_available + gauge.seats_sold + gauge.held).toBe(CAPACITY);
      const [sold] = await dataSource.query<{ seats: number }[]>(
        'SELECT count(*)::int AS seats FROM seat WHERE date_id = $1',
        [dateId],
      );
      expect(sold?.seats).toBe(gauge.seats_sold);
      expect(
        (outcomes.get(PurchaseStatus.PAID) ?? 0) +
          (outcomes.get(PurchaseStatus.AWAITING_PAYMENT) ?? 0),
      ).toBe(gauge.active_holds + (await paidOrders(dateId)));
    },
    CASE_MS,
  );
});

async function paidOrders(dateId: string): Promise<number> {
  const [row] = await dataSource.query<{ paid: number }[]>(
    'SELECT count(*)::int AS paid FROM seat_order WHERE date_id = $1 AND paid_at IS NOT NULL',
    [dateId],
  );
  return row?.paid ?? 0;
}
