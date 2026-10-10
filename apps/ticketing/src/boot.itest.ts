import { DateScheduledSchema } from '@arthome-platform/events';
import { retryTopic } from '@arthome-platform/messaging';
import {
  applyMigrations,
  createDatabase,
  mintInternalToken,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  Kafka,
  type Consumer,
  type ConsumerRunConfig,
  type EachMessagePayload,
  type Producer,
  type ProducerRecord,
} from 'kafkajs';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ApiErrorCode,
  PriceTier,
  RefundReason,
  Service,
  SystemClock,
  OrderState,
  SeatHoldOrigin,
  SeatHoldState,
  WaitlistEntryState,
  money,
} from '@arthome/core';

/**
 * The four processes' root modules, booted as `main.ts`, `consumer.ts`, `sweeper.ts` and
 * `worker.ts` boot them, against a real Postgres and, for the worker, a real Redis: a module the
 * root graph misses, or its `CqrsModule.forRoot()` dropped, fails here rather than at a deploy.
 * Kafka is stubbed. The service's modules are imported only once `DATABASE_URL` and `REDIS_URL`
 * name the containers, since `env.ts` reads the first at import.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

const DATE_ID = '01a0f100-0000-7000-8000-000000000001';
const HELD_DATE_ID = '01a0f100-0000-7000-8000-000000000002';
const HOLD_ID = '01a0f100-0000-7000-8000-0000000000b1';
const ORDER_ID = '01a0f100-0000-7000-8000-0000000000a1';
const WORKER_DATE_ID = '01a0f100-0000-7000-8000-000000000003';
const WINDOW_DATE_ID = '01a0f100-0000-7000-8000-000000000004';
const WINDOW_ENTRY_ID = '01a0f100-0000-7000-8000-0000000000e4';
const WINDOW_ACCOUNT_ID = '01a0f100-0000-7000-8000-0000000000c4';
const WORKER_HOLD_ID = '01a0f100-0000-7000-8000-0000000000b3';
const WORKER_ORDER_ID = '01a0f100-0000-7000-8000-0000000000a3';
const WORKER_REFUND_ID = '01a0f100-0000-7000-8000-0000000000f3';
/** Long enough for the shutdown to start while the provider call is in flight. */
const PROVIDER_CALL_MS = 1_000;

let stack: StartedStack;
let databaseUrl: string;

beforeAll(async () => {
  stack = await startStack({ postgres: true, redis: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'ticketing_boot_itest');
  process.env.DATABASE_URL = database.url;
  process.env.REDIS_URL = stack.redis.url;
  databaseUrl = database.url;
  const { TICKETING_SCHEMA } = await import('./itest/schema.js');
  await (await applyMigrations(database, TICKETING_SCHEMA)).destroy();
}, STARTUP_MS);

afterAll(async () => {
  await stack?.stop();
});

describe('the API process', () => {
  it(
    'boots AppModule, answers its probes and refuses through its own global providers',
    async () => {
      const { AppModule } = await import('./app.module.js');
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
        logger: false,
      });
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      try {
        expect((await app.inject({ method: 'GET', url: '/health/liveness' })).statusCode).toBe(200);
        // No connector in the harness: the slot and the publication are degraded, not down.
        const readiness = await app.inject({ method: 'GET', url: '/health/readiness' });
        expect(readiness.statusCode).toBe(200);
        expect(readiness.json()).toMatchObject({ data: { status: 'degraded' } });

        const missing = await app.inject({
          method: 'GET',
          url: `/v1/dates/${DATE_ID}/panes/tickets`,
          headers: {
            authorization: `Bearer ${await mintInternalToken({
              service: Service.TICKETING,
              clock: new SystemClock(),
            })}`,
          },
        });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toMatchObject({ error: { code: ApiErrorCode.NOT_FOUND } });
      } finally {
        await app.close();
      }
    },
    CASE_MS,
  );
});

/** Records what the consumer does with Kafka, and whether the pool was open when it stopped. */
class StubKafka {
  public readonly subscribed: string[][] = [];
  public readonly handlers: ConsumerRunConfig['eachMessage'][] = [];
  public readonly sent: ProducerRecord[] = [];
  public readonly poolOpenAtStop: boolean[] = [];
  public poolOpen: () => boolean = () => false;

  public producer(): Producer {
    return {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      send: (record: ProducerRecord) => {
        this.sent.push(record);
        return Promise.resolve([]);
      },
    } as unknown as Producer;
  }

  public consumer(): Consumer {
    return {
      connect: () => Promise.resolve(),
      subscribe: ({ topics }: { topics: string[] }) => {
        this.subscribed.push(topics);
        return Promise.resolve();
      },
      run: ({ eachMessage }: ConsumerRunConfig) => {
        this.handlers.push(eachMessage);
        return Promise.resolve();
      },
      disconnect: () => {
        this.poolOpenAtStop.push(this.poolOpen());
        return Promise.resolve();
      },
    } as unknown as Consumer;
  }
}

describe('the consumer process', () => {
  it(
    'starts its consumers, retries a fact about a date not opened yet, stops before the pool closes',
    async () => {
      const { ConsumerModule, CATALOG_DATE_TOPIC } = await import('./consumer.module.js');
      const kafka = new StubKafka();
      const context = await Test.createTestingModule({ imports: [ConsumerModule] })
        .overrideProvider(Kafka)
        .useValue(kafka)
        .compile();
      await context.init();
      const pool = context.get(DataSource);
      kafka.poolOpen = () => pool.isInitialized;

      expect(kafka.subscribed).toEqual([[CATALOG_DATE_TOPIC], [retryTopic(Service.TICKETING)]]);
      const scheduled = create(DateScheduledSchema, {
        dateId: DATE_ID,
        startsAt: timestampFromDate(new Date('2026-12-12T19:00:00.000Z')),
        occurredAt: timestampFromDate(new Date('2026-09-27T10:00:00.000Z')),
      });
      await kafka.handlers[0]?.({
        topic: CATALOG_DATE_TOPIC,
        partition: 0,
        message: {
          key: Buffer.from(DATE_ID),
          value: Buffer.from(toBinary(DateScheduledSchema, scheduled)),
          headers: {
            'message-id': Buffer.from('01a0f1ee-0000-7000-8000-000000000001'),
            type: Buffer.from('catalog.date.scheduled.v1'),
          },
        },
      } as unknown as EachMessagePayload);
      expect(kafka.sent.map((record) => record.topic)).toEqual([retryTopic(Service.TICKETING)]);

      await context.close();
      expect(kafka.poolOpenAtStop).toEqual([true, true]);
      expect(pool.isInitialized).toBe(false);
    },
    CASE_MS,
  );
});

describe('the sweeper process', () => {
  it(
    'publishes a moved date on its first pass, and lets that pass commit before the pool closes',
    async () => {
      const seed = new DataSource({ type: 'postgres', url: databaseUrl });
      await seed.initialize();
      try {
        await seed.query(
          `INSERT INTO date_sales (date_id, channel_id, capacity_total, capacity_tiers,
                                   seats_available, seats_sold, waitlist_count, price_tiers,
                                   prices_locked_at, version, availability_moves)
           VALUES ($1, 'channel-boot', 10, '[]', 10, 0, 0, '[]', now(), 2, 1)`,
          [DATE_ID],
        );
        await seed.query('INSERT INTO date_availability_publication (date_id) VALUES ($1)', [
          DATE_ID,
        ]);

        const { SweeperModule } = await import('./sweeper.module.js');
        const context = await Test.createTestingModule({ imports: [SweeperModule] }).compile();
        await context.init();
        const published = async (): Promise<number> => {
          const [counted] = await seed.query<{ rows: number }[]>(
            'SELECT count(*)::int AS rows FROM outbox_event WHERE aggregateid = $1',
            [DATE_ID],
          );
          return counted?.rows ?? 0;
        };
        try {
          const deadline = Date.now() + 10_000;
          while ((await published()) === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } finally {
          await context.close();
        }

        expect(await published()).toBe(1);
        const [row] = await seed.query<{ published_moves: string }[]>(
          'SELECT published_moves FROM date_availability_publication WHERE date_id = $1',
          [DATE_ID],
        );
        expect(row?.published_moves).toBe('1');
      } finally {
        await seed.destroy();
      }
    },
    CASE_MS,
  );
  it(
    'expires a hold past its expiry on its first pass, its seats back and its order failed',
    async () => {
      const seed = new DataSource({ type: 'postgres', url: databaseUrl });
      await seed.initialize();
      try {
        await seed.query(
          `INSERT INTO date_sales (date_id, channel_id, capacity_total, capacity_tiers,
                                   seats_available, seats_sold, waitlist_count, price_tiers,
                                   prices_locked_at, version)
           VALUES ($1, 'channel-boot', 10, '[]', 8, 0, 0, '[]', now(), 2)`,
          [HELD_DATE_ID],
        );
        await seed.query(
          `INSERT INTO seat_hold (id, date_id, tier, quantity, origin, origin_ref, expires_at,
                                  state, version)
           VALUES ($1, $2, $4, 2, $5, $3, now() - interval '1 second', $6, 1)`,
          [
            HOLD_ID,
            HELD_DATE_ID,
            ORDER_ID,
            PriceTier.FULL,
            SeatHoldOrigin.CHECKOUT,
            SeatHoldState.ACTIVE,
          ],
        );
        await seed.query(
          `INSERT INTO seat_order (id, reference, idempotency_key, fingerprint, date_id, channel_id,
                                   tier, quantity, currency_code, unit_price_minor,
                                   tier_total_minor, service_fee_minor, discount_minor,
                                   total_minor, hold_id, expires_at, state, placed_at, version)
           VALUES ($1, 'ATH-2026-99999', $1, 'boot', $2, 'channel-boot', $4, 2, 'EUR', 2400,
                   4800, 0, 0, 4800, $3, now() - interval '1 second', $5, now(), 1)`,
          [ORDER_ID, HELD_DATE_ID, HOLD_ID, PriceTier.FULL, OrderState.PENDING],
        );

        const { SweeperModule } = await import('./sweeper.module.js');
        const context = await Test.createTestingModule({ imports: [SweeperModule] }).compile();
        await context.init();
        const holdState = async (): Promise<string | undefined> => {
          const [hold] = await seed.query<{ state: string }[]>(
            'SELECT state FROM seat_hold WHERE id = $1',
            [HOLD_ID],
          );
          return hold?.state;
        };
        try {
          const deadline = Date.now() + 10_000;
          while ((await holdState()) === SeatHoldState.ACTIVE && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } finally {
          await context.close();
        }

        expect(await holdState()).toBe(SeatHoldState.EXPIRED);
        const [row] = await seed.query<{ seats_available: number; state: string }[]>(
          `SELECT sales.seats_available, placed.state
             FROM date_sales AS sales JOIN seat_order AS placed USING (date_id)
            WHERE placed.id = $1`,
          [ORDER_ID],
        );
        expect(row).toEqual({ seats_available: 10, state: OrderState.FAILED });
      } finally {
        await seed.destroy();
      }
    },
    CASE_MS,
  );
  it(
    'ends a priority window past its end on its first pass, the pool on sale and the entry lapsed',
    async () => {
      const seed = new DataSource({ type: 'postgres', url: databaseUrl });
      await seed.initialize();
      try {
        await seed.query(
          `INSERT INTO date_sales (date_id, channel_id, capacity_total, capacity_tiers,
                                   seats_available, seats_sold, waitlist_count, price_tiers,
                                   prices_locked_at, version, priority_pool_seats, priority_until)
           VALUES ($1, 'channel-boot', 10, '[]', 0, 7, 1, '[]', now(), 2, 3,
                   now() - interval '1 second')`,
          [WINDOW_DATE_ID],
        );
        await seed.query(
          `INSERT INTO waitlist_entry (id, date_id, account_id, state, joined_at, notified_at,
                                       version)
           VALUES ($1, $2, $3, $4, now() - interval '2 hours', now() - interval '2 hours', 2)`,
          [WINDOW_ENTRY_ID, WINDOW_DATE_ID, WINDOW_ACCOUNT_ID, WaitlistEntryState.NOTIFIED],
        );

        const { SweeperModule } = await import('./sweeper.module.js');
        const context = await Test.createTestingModule({ imports: [SweeperModule] }).compile();
        await context.init();
        const windowOf = async () => {
          const [row] = await seed.query<
            { seats_available: number; priority_pool_seats: number; waitlist_count: number }[]
          >(
            `SELECT seats_available, priority_pool_seats, waitlist_count FROM date_sales
              WHERE date_id = $1 AND priority_until IS NULL`,
            [WINDOW_DATE_ID],
          );
          return row;
        };
        try {
          const deadline = Date.now() + 10_000;
          while ((await windowOf()) === undefined && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } finally {
          await context.close();
        }

        expect(await windowOf()).toEqual({
          seats_available: 3,
          priority_pool_seats: 0,
          waitlist_count: 0,
        });
        expect(
          await seed.query('SELECT state FROM waitlist_entry WHERE id = $1', [WINDOW_ENTRY_ID]),
        ).toEqual([{ state: WaitlistEntryState.LAPSED }]);
      } finally {
        await seed.destroy();
      }
    },
    CASE_MS,
  );
});

describe('the worker process', () => {
  it(
    'boots on Redis, makes a refund owed, and lets the job in flight commit before the pool closes',
    async () => {
      const seed = new DataSource({ type: 'postgres', url: databaseUrl });
      await seed.initialize();
      try {
        await seed.query(
          `INSERT INTO date_sales (date_id, channel_id, capacity_total, capacity_tiers,
                                   seats_available, seats_sold, waitlist_count, price_tiers,
                                   prices_locked_at, version)
           VALUES ($1, 'channel-boot', 10, '[]', 8, 2, 0, '[]', now(), 2)`,
          [WORKER_DATE_ID],
        );
        await seed.query(
          `INSERT INTO seat_hold (id, date_id, tier, quantity, origin, origin_ref, expires_at,
                                  state, version)
           VALUES ($1, $2, $4, 2, $5, $3, now(), $6, 2)`,
          [
            WORKER_HOLD_ID,
            WORKER_DATE_ID,
            WORKER_ORDER_ID,
            PriceTier.FULL,
            SeatHoldOrigin.CHECKOUT,
            SeatHoldState.CONSUMED,
          ],
        );
        const { FakePaymentProvider, intentRefOf } =
          await import('./payments/fake-payment-provider.js');
        await seed.query(
          `INSERT INTO seat_order (id, reference, idempotency_key, fingerprint, date_id, channel_id,
                                   tier, quantity, currency_code, unit_price_minor,
                                   tier_total_minor, service_fee_minor, discount_minor,
                                   total_minor, hold_id, expires_at, state, placed_at, paid_at,
                                   version, payment_intent_ref)
           VALUES ($1, 'ATH-2026-99998', $1, 'boot', $2, 'channel-boot', $4, 2, 'EUR', 2400,
                   4800, 0, 0, 4800, $3, now(), $5, now(), now(), 2, $6)`,
          [
            WORKER_ORDER_ID,
            WORKER_DATE_ID,
            WORKER_HOLD_ID,
            PriceTier.FULL,
            OrderState.PAID,
            intentRefOf(WORKER_ORDER_ID),
          ],
        );
        await seed.query(
          `INSERT INTO order_refund (id, order_id, amount_minor, currency_code, reason,
                                     idempotency_key, owed_at)
           VALUES ($1, $2, 4800, 'EUR', $3, $4, now())`,
          [WORKER_REFUND_ID, WORKER_ORDER_ID, RefundReason.GOODWILL, `refund:${WORKER_REFUND_ID}`],
        );
        const fake = new FakePaymentProvider('a'.repeat(32), new SystemClock());
        await fake.createIntent({
          orderId: WORKER_ORDER_ID,
          amount: money(4800, 'EUR'),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          returnUrl: 'http://storefront.test/orders/boot',
        });
        const refund = fake.refund.bind(fake);
        let inFlight: () => void = () => undefined;
        const asked = new Promise<void>((resolve) => {
          inFlight = resolve;
        });
        fake.refund = async (request) => {
          inFlight();
          await new Promise((resolve) => setTimeout(resolve, PROVIDER_CALL_MS));
          return refund(request);
        };

        const { WorkerModule } = await import('./worker.module.js');
        const context = await Test.createTestingModule({ imports: [WorkerModule] })
          .overrideProvider(FakePaymentProvider)
          .useValue(fake)
          .compile();
        await context.init();
        const pool = context.get(DataSource);
        try {
          await Promise.race([
            asked,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('no refund asked within 10 s')), 10_000),
            ),
          ]);
        } finally {
          await context.close();
        }

        expect(pool.isInitialized).toBe(false);
        const [made] = await seed.query<{ refund_ref: string | null; state: string }[]>(
          `SELECT refund.refund_ref, placed.state
             FROM order_refund AS refund JOIN seat_order AS placed ON placed.id = refund.order_id
            WHERE refund.id = $1`,
          [WORKER_REFUND_ID],
        );
        expect(made?.refund_ref).not.toBeNull();
        expect(made?.state).toBe(OrderState.REFUNDED);
      } finally {
        await seed.destroy();
      }
    },
    CASE_MS,
  );
});
