import {
  DateScheduledSchema,
  ReplayPolicy as WireReplayPolicy,
  RightsScope as WireRightsScope,
  SeatActivatedSchema,
  SubscriptionChangedSchema,
  SubscriptionState as WireSubscriptionState,
} from '@arthome-platform/events';
import { deadLetterTopic, retryTopic, runConsumers } from '@arthome-platform/messaging';
import { createTopics } from '@arthome-platform/testing';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Logger } from '@nestjs/common';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ENTITLEMENT_PROJECTION_MAX_STALENESS_SECONDS, SystemClock } from '@arthome/core';

import { STALENESS_METRIC } from './freshness.js';
import { applyStreamingMessage } from '../consumed-messages.js';
import {
  ACCOUNT_TOPIC,
  CATALOG_DATE_TOPIC,
  DATE_SALES_TOPIC,
  startProjection,
  wireMessage,
  type Projection,
  type WireMessage,
} from '../itest/entitlement.js';
import { SERVICE } from '../service.js';

/**
 * The freshness budget measured, not assumed (R8, `data-model.md` §4): on a real broker, the
 *   consumer joined, 100 facts over the three topics each visible within 5 s of being produced; a
 *   fact older than the budget logs the staleness metric.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 120_000;
const BUDGET_MS = ENTITLEMENT_PROJECTION_MAX_STALENESS_SECONDS * 1_000;
const POLL_MS = 10;

let projection: Projection;
let producer: Producer;
let stopConsumers: () => Promise<void> = () => Promise.resolve();

const idOf = (prefix: string, n: number): string =>
  `${prefix}-0000-7000-8000-${String(n).padStart(12, '0')}`;

interface Fact {
  readonly message: WireMessage;
  readonly visible: string;
  readonly id: string;
}

function seatFact(n: number, occurredAt: Date): Fact {
  const seatId = idOf('01a0f560', n);
  const dateId = idOf('01a0f561', n % 7);
  return {
    message: wireMessage(
      DATE_SALES_TOPIC,
      'ticketing.seat.activated.v1',
      SeatActivatedSchema,
      dateId,
      {
        seatId,
        accountId: idOf('01a0f562', n),
        dateId,
        occurredAt: timestampFromDate(occurredAt),
      },
    ),
    visible: 'SELECT 1 FROM entitlement_seat WHERE seat_id = $1',
    id: seatId,
  };
}

function subscriptionFact(n: number, occurredAt: Date): Fact {
  const accountId = idOf('01a0f563', n);
  return {
    message: wireMessage(
      ACCOUNT_TOPIC,
      'ticketing.subscription.changed.v1',
      SubscriptionChangedSchema,
      accountId,
      { accountId, state: WireSubscriptionState.ACTIVE, occurredAt: timestampFromDate(occurredAt) },
    ),
    visible: 'SELECT 1 FROM entitlement_subscription WHERE account_id = $1',
    id: accountId,
  };
}

function dateFact(n: number, occurredAt: Date): Fact {
  const dateId = idOf('01a0f564', n);
  return {
    message: wireMessage(
      CATALOG_DATE_TOPIC,
      'catalog.date.scheduled.v1',
      DateScheduledSchema,
      dateId,
      {
        dateId,
        channelId: 'channel-freshness',
        startsAt: timestampFromDate(new Date('2026-12-12T19:00:00.000Z')),
        runtimeMin: 90,
        replayPolicy: WireReplayPolicy.NONE,
        rights: { scope: WireRightsScope.WORLDWIDE },
        occurredAt: timestampFromDate(occurredAt),
      },
    ),
    visible: 'SELECT 1 FROM entitlement_date WHERE date_id = $1',
    id: dateId,
  };
}

const FACTS = [seatFact, subscriptionFact, dateFact];

async function visibleAfterMs(fact: Fact, sentAt: number): Promise<number> {
  const deadline = sentAt + 30_000;
  for (;;) {
    const rows = await projection.dataSource.query<unknown[]>(fact.visible, [fact.id]);
    const now = performance.now();
    if (rows.length > 0) return now - sentAt;
    if (now > deadline) throw new Error(`${fact.message.topic} ${fact.id} never became visible`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function sentAndSeen(fact: Fact): Promise<number> {
  const sentAt = performance.now();
  await producer.send({ topic: fact.message.topic, messages: [fact.message] });
  return visibleAfterMs(fact, sentAt);
}

beforeAll(async () => {
  projection = await startProjection('streaming_entitlement_freshness_itest', new SystemClock(), {
    kafka: true,
    startupTimeoutMs: STARTUP_MS,
  });
  const kafka = new Kafka({
    clientId: 'streaming-freshness-itest',
    brokers: [...projection.stack.kafka.brokers],
    logLevel: logLevel.NOTHING,
  });
  await createTopics(kafka, [
    { topic: DATE_SALES_TOPIC, partitions: 12 },
    { topic: ACCOUNT_TOPIC, partitions: 3 },
    { topic: CATALOG_DATE_TOPIC, partitions: 12 },
    { topic: retryTopic(SERVICE), partitions: 3 },
    { topic: deadLetterTopic(SERVICE), partitions: 3 },
  ]);
  producer = kafka.producer();
  await producer.connect();
  stopConsumers = await runConsumers({
    kafka,
    producer,
    service: SERVICE,
    sources: [DATE_SALES_TOPIC, ACCOUNT_TOPIC, CATALOG_DATE_TOPIC].map((topic) => ({
      topic,
      handler: (payload) => applyStreamingMessage(projection.commands, payload),
    })),
  });
  // Joined once one fact per topic is through: the measure below starts from a consumer that reads.
  for (const [n, fact] of FACTS.entries()) await sentAndSeen(fact(1_000 + n, new Date()));
}, STARTUP_MS);

afterAll(async () => {
  await stopConsumers();
  await producer?.disconnect();
  await projection?.close();
});

describe('the entitlement projection under its freshness budget', () => {
  it(
    'makes each of 100 facts over the three topics visible within 5 s of being produced',
    async ({ annotate }) => {
      const warn = vi.spyOn(Logger.prototype, 'warn');
      const lags: number[] = [];
      for (let n = 0; n < 100; n += 1) {
        const fact = FACTS[n % FACTS.length];
        if (fact === undefined) throw new Error('no fact');
        lags.push(await sentAndSeen(fact(n, new Date())));
      }

      const sorted = [...lags].sort((a, b) => a - b);
      const at = (quantile: number): number => sorted[Math.ceil(quantile * sorted.length) - 1] ?? 0;
      await annotate(
        `visible after p50 ${at(0.5).toFixed(0)} ms, p95 ${at(0.95).toFixed(0)} ms, ` +
          `max ${at(1).toFixed(0)} ms`,
      );
      expect(lags).toHaveLength(100);
      expect(at(1)).toBeLessThan(BUDGET_MS);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(STALENESS_METRIC));
      warn.mockRestore();
    },
    CASE_MS,
  );

  it(
    'logs the staleness metric for a fact applied past the budget, with its type and date',
    async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn');
      const stale = seatFact(2_000, new Date(Date.now() - 60_000));

      await sentAndSeen(stale);

      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(
            `^${STALENESS_METRIC}=6\\d\\.\\d{3} type=ticketing\\.seat\\.activated\\.v1 date=`,
          ),
        ),
      );
      warn.mockRestore();
    },
    CASE_MS,
  );
});
