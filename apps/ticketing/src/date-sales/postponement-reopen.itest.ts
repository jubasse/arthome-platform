import { Outcome } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  httpApp,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { CommandBus } from '@nestjs/cqrs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FixedClock, plusMinutes } from '@arthome/core';

import { CLOCK } from '../clock.js';
import { applyCatalogDateMessage } from './catalog-date-messages.js';
import { CatalogFactsModule } from './catalog-facts.module.js';
import { CloseEndedSales } from './close-ended-sales.command.js';
import { DateSalesModule } from './date-sales.module.js';
import { SalesClosingSweeper } from './sales-closing-sweeper.js';
import { SalesClosingModule } from './sales-closing.module.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';
import { delivered, rescheduled } from '../itest/catalog-messages.js';
import { purchaseOf, putOnSale } from '../itest/sales.js';
import { TICKETING_SCHEMA } from '../itest/schema.js';
import { HoldExpirySweeper } from '../orders/hold-expiry-sweeper.js';
import { HoldExpiryModule } from '../orders/hold-expiry.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { FakePaymentProvider, FakePaymentScenario } from '../payments/fake-payment-provider.js';
import { PaymentWebhooksModule } from '../payments/payment-webhooks.module.js';
import { PaymentWorker } from '../payments/payment-worker.js';
import { PaymentWorkerModule } from '../payments/payment-worker.module.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';

/**
 * The T3 correctness review's case on a postponement applied after its sale closed by time, as the
 *   reviewer wrote it: the sale reopens until thirty minutes after the new start.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

const CHANNEL = '01a0fd0c-0000-7000-8000-000000000001';

let stack: StartedStack;
let dataSource: DataSource;
let app: NestFastifyApplication;
let clock: FixedClock;
let fake: FakePaymentProvider;
let dates = 0;

const commands = (): CommandBus => app.get(CommandBus);

function nextDateId(): string {
  dates += 1;
  return `01a0fd00-0000-7000-8000-${String(dates).padStart(12, '0')}`;
}

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_postponement_reopen_itest');
  dataSource = await applyMigrations(database, TICKETING_SCHEMA);
  clock = new FixedClock('2026-09-28T10:00:00.000Z');
  fake = new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock);
  app = await httpApp({
    imports: [
      OrdersModule,
      PaymentWebhooksModule,
      PaymentWorkerModule,
      HoldExpiryModule,
      SalesClosingModule,
      DateSalesModule,
      CatalogFactsModule,
    ],
    providers: EDGE_PROVIDERS,
    dataSource,
    rawBody: true,
    overrides: [
      [CLOCK, clock],
      [FakePaymentProvider, fake],
      [PUBLIC_WEB_ORIGIN, 'http://storefront.test'],
      [PaymentWorker, {}],
      [HoldExpirySweeper, {}],
      [SalesClosingSweeper, {}],
    ],
  });
}, STARTUP_MS);

beforeEach(() => {
  fake.scenarioOf = () => FakePaymentScenario.CONFIRM;
  fake.down = false;
});

afterAll(async () => {
  await app?.close();
  await stack?.stop();
});

describe('a postponement the consumer applies after the sweeper closed the sale by time', () => {
  it(
    'reopens the sale until thirty minutes after the new start (adr-ticketing.md §8)',
    async () => {
      const dateId = nextDateId();
      const startedAt = plusMinutes(clock.now(), -31);
      // Scheduled two days ago; postponed five minutes before the old start (core refuses a
      //   postponement once the live started), and delivered only now, after a consumer lag.
      await putOnSale(
        commands(),
        { dateId, channelId: CHANNEL, capacity: 10, startsAt: startedAt },
        plusMinutes(clock.now(), -2 * 24 * 60),
      );
      await commands().execute(new CloseEndedSales());
      const [closed] = await dataSource.query<{ on_sale: boolean }[]>(
        'SELECT on_sale FROM date_sales WHERE date_id = $1',
        [dateId],
      );
      expect(closed?.on_sale).toBe(false);

      const newStart = plusMinutes(clock.now(), 7 * 24 * 60);
      expect(
        await applyCatalogDateMessage(
          commands(),
          delivered(rescheduled(dateId, newStart, plusMinutes(startedAt, -5))),
        ),
      ).toBe(Outcome.APPLIED);

      const [moved] = await dataSource.query<{ on_sale: boolean; sales_end_at: Date }[]>(
        'SELECT on_sale, sales_end_at FROM date_sales WHERE date_id = $1',
        [dateId],
      );
      expect(moved?.sales_end_at).toEqual(new Date(plusMinutes(newStart, 30)));
      expect(moved?.on_sale).toBe(true);
      const bought = await commands().execute(purchaseOf(dateId, 1));
      expect(bought.status).toBe(201);
    },
    CASE_MS,
  );
});
