import { DateSalesAvailabilityChangedSchema } from '@arthome-platform/events';
import { RefusalException } from '@arthome-platform/http-edge';
import { OutboxEvent } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { CommandBus, CqrsModule } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FixedClock, plusMinutes, plusSeconds } from '@arthome/core';

import { ApplyCatalogDateFactHandler } from './apply-catalog-date-fact.handler.js';
import { applyCatalogDateMessage } from './catalog-date-messages.js';
import { CloseEndedSales } from './close-ended-sales.command.js';
import { CloseEndedSalesHandler } from './close-ended-sales.handler.js';
import { OpenCapacityTierHandler } from './open-capacity-tier.handler.js';
import { SetDatePricesHandler } from './set-date-prices.handler.js';
import { PublishDueAvailability } from '../availability/publish-due-availability.command.js';
import { PublishDueAvailabilityHandler } from '../availability/publish-due-availability.handler.js';
import { CLOCK } from '../clock.js';
import { delivered, rescheduled } from '../itest/catalog-messages.js';
import { purchaseOf, putOnSale } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { INTERIM_SALES_CLOSED } from '../orders/purchase-refusals.js';
import { PurchaseSeatHandler } from '../orders/purchase-seat.handler.js';
import { FakePaymentProvider } from '../payments/fake-payment-provider.js';
import { OwedRefunds } from '../payments/owed-refunds.js';
import { PaymentPort } from '../payments/payment.port.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { TicketingTransactions } from '../ticketing-transactions.js';

/**
 * The sweeper's closing of a sale whose end by time passed (D-089): closed as an outcome closes it,
 *   published a last time, and no seat sold after it; the end moved by a postponement.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const NOW = '2026-09-28T10:00:00.000Z';
const CHANNEL = '01a0f80c-0000-7000-8000-000000000001';

let stack: StartedStack;
let dataSource: DataSource;
let cqrs: TestingModule;
let commands: CommandBus;
let dates = 0;

async function dateOnSale(salesEndAt: string | null): Promise<string> {
  dates += 1;
  const dateId = `01a0f800-0000-7000-8000-${String(dates).padStart(12, '0')}`;
  await putOnSale(commands, { dateId, channelId: CHANNEL, capacity: 10 }, NOW);
  await dataSource.query('UPDATE date_sales SET sales_end_at = $2 WHERE date_id = $1', [
    dateId,
    salesEndAt,
  ]);
  return dateId;
}

async function rowOf(dateId: string) {
  const [row] = await dataSource.query<
    { on_sale: boolean; sales_closed_at: Date | null; closing_due: boolean }[]
  >(
    `SELECT sales.on_sale, sales.sales_closed_at, publication.closing_due
       FROM date_sales AS sales JOIN date_availability_publication AS publication USING (date_id)
      WHERE date_id = $1`,
    [dateId],
  );
  return row;
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_sales_end_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  const clock = new FixedClock(NOW);
  cqrs = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      TicketingTransactions,
      ApplyCatalogDateFactHandler,
      OpenCapacityTierHandler,
      SetDatePricesHandler,
      CloseEndedSalesHandler,
      PublishDueAvailabilityHandler,
      PurchaseSeatHandler,
      OwedRefunds,
      { provide: DataSource, useValue: dataSource },
      { provide: CLOCK, useValue: clock },
      { provide: PaymentPort, useValue: new FakePaymentProvider('a'.repeat(32), clock) },
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

describe('a pass of the sales closing', () => {
  it(
    'closes a sale past its end, publishes it a last time, and sells nothing after it',
    async () => {
      const ended = plusSeconds(NOW, -1);
      const dateId = await dateOnSale(ended);
      const running = await dateOnSale(plusSeconds(NOW, 3_600));
      const endless = await dateOnSale(null);

      expect(await commands.execute(new CloseEndedSales())).toBe(1);
      expect(await commands.execute(new CloseEndedSales())).toBe(0);

      expect(await rowOf(dateId)).toEqual({
        on_sale: false,
        sales_closed_at: new Date(ended),
        closing_due: true,
      });
      expect((await rowOf(running))?.on_sale).toBe(true);
      expect((await rowOf(endless))?.on_sale).toBe(true);

      await commands.execute(new PublishDueAvailability());
      const [last] = await dataSource.getRepository(OutboxEvent).find({
        where: { aggregateid: dateId, type: 'ticketing.date_sales.availability_changed.v1' },
        order: { id: 'DESC' },
        take: 1,
      });
      expect(
        fromBinary(DateSalesAvailabilityChangedSchema, last?.payload ?? new Uint8Array()),
      ).toMatchObject({ seatsAvailable: 0, soldOut: false });

      let refusal: unknown;
      try {
        await commands.execute(purchaseOf(dateId, 1));
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(RefusalException);
      expect((refusal as RefusalException).refusal.code).toBe(INTERIM_SALES_CLOSED);
    },
    CASE_MS,
  );
});

describe('the cutoff, thirty minutes after the start (D-089)', () => {
  it(
    'closes a sale thirty minutes after its start, and a postponement moves the cutoff',
    async () => {
      dates += 1;
      const passed = `01a0f800-0000-7000-8000-${String(dates).padStart(12, '0')}`;
      const startedAt = plusMinutes(NOW, -31);
      await putOnSale(
        commands,
        { dateId: passed, channelId: CHANNEL, capacity: 10, startsAt: startedAt },
        NOW,
      );
      dates += 1;
      const postponed = `01a0f800-0000-7000-8000-${String(dates).padStart(12, '0')}`;
      await putOnSale(
        commands,
        { dateId: postponed, channelId: CHANNEL, capacity: 10, startsAt: startedAt },
        NOW,
      );
      const newStart = plusMinutes(NOW, 60);
      await applyCatalogDateMessage(
        commands,
        delivered(rescheduled(postponed, newStart, plusSeconds(NOW, 1))),
      );

      expect(await commands.execute(new CloseEndedSales())).toBe(1);

      expect(await rowOf(passed)).toEqual({
        on_sale: false,
        sales_closed_at: new Date(plusMinutes(startedAt, 30)),
        closing_due: true,
      });
      const [moved] = await dataSource.query<{ on_sale: boolean; sales_end_at: Date }[]>(
        'SELECT on_sale, sales_end_at FROM date_sales WHERE date_id = $1',
        [postponed],
      );
      expect(moved).toEqual({ on_sale: true, sales_end_at: new Date(plusMinutes(newStart, 30)) });
    },
    CASE_MS,
  );
});
