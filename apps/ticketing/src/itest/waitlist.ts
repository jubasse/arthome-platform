import { WaitlistNotifiedSchema } from '@arthome-platform/events';
import {
  RefusalException,
  domainRefusal,
  idempotentRequestOf,
  type MemorisedResponse,
} from '@arthome-platform/http-edge';
import { OutboxEvent } from '@arthome-platform/messaging';
import { applyMigrations, createDatabase, type StartedStack } from '@arthome-platform/testing';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { CommandBus, CqrsModule, QueryBus } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import {
  FixedClock,
  PriceTier,
  SeatHoldState,
  WaitlistEntryState,
  isDomainError,
  type Instant,
} from '@arthome/core';

import { FULL_PRICE_MINOR, nextKey, putOnSale } from './sales.js';
import { TICKETING_SCHEMA } from './schema.js';
import { PublishDueAvailabilityHandler } from '../availability/publish-due-availability.handler.js';
import { CLOCK } from '../clock.js';
import { SettleDateOutcomesHandler } from '../date-outcomes/settle-date-outcomes.handler.js';
import { WaitlistOutcomeHook } from '../date-outcomes/waitlist-outcome-hook.js';
import { ApplyCatalogDateFactHandler } from '../date-sales/apply-catalog-date-fact.handler.js';
import type { OpenedCapacityTier } from '../date-sales/open-capacity-tier.command.js';
import { OpenCapacityTier } from '../date-sales/open-capacity-tier.command.js';
import { OpenCapacityTierHandler } from '../date-sales/open-capacity-tier.handler.js';
import { SetDatePricesHandler } from '../date-sales/set-date-prices.handler.js';
import { ExpireDueHoldsHandler } from '../orders/expire-due-holds.handler.js';
import { PurchaseSeat, type PurchaseAnswer } from '../orders/purchase-seat.command.js';
import { PurchaseSeatHandler } from '../orders/purchase-seat.handler.js';
import { QuoteSeatHandler } from '../orders/quote-seat.handler.js';
import { FakePaymentProvider } from '../payments/fake-payment-provider.js';
import { PAYMENT_PORT } from '../payments/payment-tokens.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { TicketingTransactions } from '../ticketing-transactions.js';
import { EndPriorityWindowsHandler } from '../waitlist/end-priority-windows.handler.js';
import { GetWaitlistRegistrationHandler } from '../waitlist/get-waitlist-registration.handler.js';
import { JoinWaitlist } from '../waitlist/join-waitlist.command.js';
import { JoinWaitlistHandler } from '../waitlist/join-waitlist.handler.js';
import { LeaveWaitlist } from '../waitlist/leave-waitlist.command.js';
import { LeaveWaitlistHandler } from '../waitlist/leave-waitlist.handler.js';
import { WaitlistEndingHook } from '../waitlist/waitlist-ending-hook.js';
import type { WaitlistRegistrationView } from '../waitlist/waitlist-registration.js';

/** The waiting list's suites: one database each, the real buses, the fake provider confirming. */
export interface WaitlistHarness {
  readonly dataSource: DataSource;
  readonly commands: CommandBus;
  readonly queries: QueryBus;
  readonly clock: FixedClock;
  readonly fake: FakePaymentProvider;
  readonly transactions: TicketingTransactions;
  close(): Promise<void>;
}

export const WAITLIST_CHANNEL = '01a0fc0c-0000-7000-8000-000000000001';

export async function startWaitlistHarness(
  stack: StartedStack,
  database: string,
  now: Instant,
): Promise<WaitlistHarness> {
  const dataSource = await applyMigrations(
    await createDatabase(stack.postgres, database),
    TICKETING_SCHEMA,
  );
  const clock = new FixedClock(now);
  const fake = new FakePaymentProvider('a-webhook-secret-long-enough-to-pass', clock);
  const module: TestingModule = await Test.createTestingModule({
    imports: [CqrsModule.forRoot()],
    providers: [
      TicketingTransactions,
      ApplyCatalogDateFactHandler,
      OpenCapacityTierHandler,
      SetDatePricesHandler,
      PurchaseSeatHandler,
      QuoteSeatHandler,
      ExpireDueHoldsHandler,
      JoinWaitlistHandler,
      LeaveWaitlistHandler,
      GetWaitlistRegistrationHandler,
      EndPriorityWindowsHandler,
      SettleDateOutcomesHandler,
      PublishDueAvailabilityHandler,
      { provide: WaitlistOutcomeHook, useClass: WaitlistEndingHook },
      { provide: DataSource, useValue: dataSource },
      { provide: CLOCK, useValue: clock },
      { provide: PAYMENT_PORT, useValue: fake },
      { provide: PUBLIC_WEB_ORIGIN, useValue: 'http://storefront.test' },
    ],
  }).compile();
  await module.init();
  return {
    dataSource,
    commands: module.get(CommandBus),
    queries: module.get(QueryBus),
    clock,
    fake,
    transactions: module.get(TicketingTransactions),
    close: async () => {
      await module.close();
      await dataSource.destroy();
    },
  };
}

/** The `n`th account of a suite's `series`, eight hex digits. */
export function accountOf(series: string, n: number): string {
  return `${series}-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

export function joinOf(dateId: string, accountId: string, key: string = nextKey()): JoinWaitlist {
  return new JoinWaitlist(
    dateId,
    accountId,
    null,
    idempotentRequestOf('PUT', `/v1/dates/${dateId}/waitlist`, {}, 200, key, accountId),
  );
}

export function leaveOf(dateId: string, accountId: string, key: string = nextKey()): LeaveWaitlist {
  return new LeaveWaitlist(
    dateId,
    accountId,
    null,
    idempotentRequestOf('DELETE', `/v1/dates/${dateId}/waitlist`, {}, 200, key, accountId),
  );
}

export async function join(
  { commands }: WaitlistHarness,
  dateId: string,
  accountId: string,
  key?: string,
): Promise<WaitlistRegistrationView> {
  const response: MemorisedResponse<WaitlistRegistrationView> = await commands.execute(
    joinOf(dateId, accountId, key),
  );
  return response.envelope.data;
}

/** `quantity` full-price seats bought by `accountId`, under `key`. */
export function purchaseAs(
  accountId: string,
  dateId: string,
  quantity: number,
  key: string = nextKey(),
): PurchaseSeat {
  const body = {
    dateId,
    tier: PriceTier.FULL,
    quantity,
    expectedTotal: { amountMinor: FULL_PRICE_MINOR * quantity, currencyCode: 'EUR' },
  };
  return new PurchaseSeat(
    body,
    { accountId, profileId: null },
    null,
    idempotentRequestOf('POST', '/v1/orders/seats', body, 201, key, accountId),
    false,
  );
}

export function buy(
  { commands }: WaitlistHarness,
  accountId: string,
  dateId: string,
  quantity: number,
): Promise<PurchaseAnswer> {
  return commands.execute(purchaseAs(accountId, dateId, quantity));
}

export async function openTier(
  { commands, dataSource }: WaitlistHarness,
  dateId: string,
  additionalCapacity: number,
  notifyWaitlist = true,
): Promise<OpenedCapacityTier> {
  const [row] = await dataSource.query<{ version: number }[]>(
    'SELECT version FROM date_sales WHERE date_id = $1',
    [dateId],
  );
  const body = { expectedVersion: row?.version ?? 0, additionalCapacity, notifyWaitlist };
  const response: MemorisedResponse<OpenedCapacityTier> = await commands.execute(
    new OpenCapacityTier(dateId, body, null, {
      key: nextKey(),
      accountId: null,
      fingerprint: `${dateId}:tier:${String(additionalCapacity)}`,
      statusCode: 200,
    }),
  );
  return response.envelope.data;
}

/** A date on sale with a start, every seat sold to `buyer`: publicly sold out. */
export async function soldOutDate(
  harness: WaitlistHarness,
  dateId: string,
  capacity: number,
  buyer: string,
  startsAt: Instant,
): Promise<void> {
  await putOnSale(
    harness.commands,
    { dateId, channelId: WAITLIST_CHANNEL, capacity, startsAt },
    harness.clock.now(),
  );
  await buy(harness, buyer, dateId, capacity);
}

export interface Figures {
  readonly capacity_total: number;
  readonly seats_available: number;
  readonly priority_pool_seats: number;
  readonly seats_sold: number;
  readonly seats_held: number;
  readonly waitlist_count: number;
  readonly priority_until: Date | null;
}

export async function figuresOf(dataSource: DataSource, dateId: string): Promise<Figures> {
  const [row] = await dataSource.query<Figures[]>(
    `SELECT capacity_total, seats_available, priority_pool_seats, seats_sold, waitlist_count,
            priority_until,
            (SELECT coalesce(sum(quantity), 0)::int FROM seat_hold
              WHERE date_id = $1 AND state = $2) AS seats_held
       FROM date_sales WHERE date_id = $1`,
    [dateId, SeatHoldState.ACTIVE],
  );
  if (row === undefined) throw new Error(`no date ${dateId}`);
  return row;
}

export async function entryStatesOf(
  dataSource: DataSource,
  dateId: string,
): Promise<Record<string, number>> {
  const rows = await dataSource.query<{ state: string; entries: number }[]>(
    `SELECT state, count(*)::int AS entries FROM waitlist_entry WHERE date_id = $1
      GROUP BY state ORDER BY state`,
    [dateId],
  );
  return Object.fromEntries(rows.map(({ state, entries }) => [state, entries]));
}

export interface NotifiedRow {
  readonly accountIds: string[];
  readonly priorityUntil: Instant | null;
  readonly key: string;
}

export async function waitlistNotifiedOf(
  dataSource: DataSource,
  dateId: string,
): Promise<NotifiedRow[]> {
  const rows = await dataSource.getRepository(OutboxEvent).find({
    where: { type: 'ticketing.waitlist.notified.v1', aggregateid: dateId },
    order: { created_at: 'ASC', id: 'ASC' },
  });
  return rows.map(({ payload, aggregateid }) => {
    const notified = fromBinary(WaitlistNotifiedSchema, payload);
    return {
      accountIds: notified.accountIds,
      priorityUntil:
        notified.priorityUntil === undefined
          ? null
          : timestampDate(notified.priorityUntil).toISOString(),
      key: aggregateid,
    };
  });
}

export async function refusalOf(attempt: Promise<unknown>): Promise<RefusalException> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof RefusalException) return error;
    if (isDomainError(error)) return domainRefusal(error);
    throw error;
  }
  throw new Error('expected a refusal');
}

/** Moves the suite's clock to `instant`, forward or back. */
export function travelTo(clock: FixedClock, instant: Instant): void {
  clock.advance(Date.parse(instant) - clock.nowMs());
}

/** `count` waiting entries of `series`'s accounts 1 to `count`, and the count with them. */
export async function seedWaitingEntries(
  dataSource: DataSource,
  dateId: string,
  series: string,
  count: number,
  joinedAt: Instant,
): Promise<void> {
  await dataSource.transaction(async (manager) => {
    await manager.query(
      `INSERT INTO waitlist_entry (id, date_id, account_id, state, joined_at, version)
       SELECT gen_random_uuid(), $1, ($2 || '-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid,
              $5, $4, 1
         FROM generate_series(1, $3::int) AS n`,
      [dateId, series, count, new Date(joinedAt), WaitlistEntryState.WAITING],
    );
    await manager.query(
      'UPDATE date_sales SET waitlist_count = waitlist_count + $2 WHERE date_id = $1',
      [dateId, count],
    );
  });
}
