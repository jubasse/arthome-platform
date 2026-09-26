import { randomUUID } from 'node:crypto';

import type { Kafka } from 'kafkajs';
import type { DataSource } from 'typeorm';

import { outboxTopic } from './outbox.js';

/** `topic-retention.spec.ts` holds every topic's retention above this. */
export const REPUBLISH_HORIZON_HOURS = 144;

export interface UnpublishedRow {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly type: string;
  readonly createdAt: Date;
}

export interface Reconciliation {
  readonly checked: number;
  readonly unpublished: readonly UnpublishedRow[];
}

/** The `message-id` headers present on one topic. */
export type PublishedIdsReader = (topic: string) => Promise<ReadonlySet<string>>;

/**
 * Rows committed but absent from their topic — a fact the connector never read, which nothing
 * else would ever notice.
 *
 * ASKS THE TOPIC, NOT THE SLOT. A row carries no LSN, and comparing positions fails on exactly
 * the loss seen on 2026-09-26: a recreated slot starts past the row, so the row looks
 * confirmed while its WAL was never read.
 *
 * `settleSeconds`: younger rows may still be in flight. `horizonHours`: older rows may have left
 * the topic under retention, where absence proves nothing.
 */
export async function findUnpublishedOutboxRows(
  dataSource: DataSource,
  readPublishedIds: PublishedIdsReader,
  {
    settleSeconds = 300,
    horizonHours = REPUBLISH_HORIZON_HOURS,
  }: { settleSeconds?: number; horizonHours?: number } = {},
): Promise<Reconciliation> {
  const rows = (await dataSource.query(
    `SELECT id, aggregatetype, aggregateid, type, created_at
       FROM outbox_event
      WHERE created_at < now() - ($1 || ' seconds')::interval
        AND created_at >= now() - ($2 || ' hours')::interval
      ORDER BY created_at`,
    [String(settleSeconds), String(horizonHours)],
  )) as unknown as {
    id: string;
    aggregatetype: string;
    aggregateid: string;
    type: string;
    created_at: Date;
  }[];

  const publishedByTopic = new Map<string, ReadonlySet<string>>();
  for (const topic of new Set(rows.map((row) => outboxTopic(row.aggregatetype)))) {
    publishedByTopic.set(topic, await readPublishedIds(topic));
  }

  const unpublished = rows
    .filter((row) => !publishedByTopic.get(outboxTopic(row.aggregatetype))?.has(row.id))
    .map((row) => ({
      id: row.id,
      aggregateType: row.aggregatetype,
      aggregateId: row.aggregateid,
      type: row.type,
      createdAt: row.created_at,
    }));

  return { checked: rows.length, unpublished };
}

/**
 * Makes the connector emit the row again, under its ORIGINAL id — so the `message-id` is
 * unchanged and every consumer's deduplication absorbs it if it had in fact arrived.
 *
 * DELETE THEN INSERT, IN ONE TRANSACTION, because the outbox router routes inserts only: an
 * UPDATE is dropped, and `id` is the primary key. Verified on Debezium 3.0.0.Final that the
 * router drops the DELETE without failing the connector and emits no tombstone — a behaviour
 * of the router, not a contract, so re-check it on an upgrade.
 *
 * `false` when no row has that id.
 */
export async function republishOutboxRow(dataSource: DataSource, id: string): Promise<boolean> {
  return dataSource.transaction(async (manager) => {
    const deleted = (await manager.query(
      `DELETE FROM outbox_event WHERE id = $1
       RETURNING id, aggregatetype, aggregateid, type, payload, tracecontext, actor_id, created_at`,
      [id],
    )) as unknown;

    // pg answers a DELETE … RETURNING with [rows, rowCount].
    const rows = Array.isArray(deleted) && Array.isArray(deleted[0]) ? deleted[0] : [];
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return false;

    await manager.query(
      `INSERT INTO outbox_event
         (id, aggregatetype, aggregateid, type, payload, tracecontext, actor_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.id,
        row.aggregatetype,
        row.aggregateid,
        row.type,
        row.payload,
        row.tracecontext,
        row.actor_id,
        row.created_at,
      ],
    );
    return true;
  });
}

/**
 * Reads a topic from its retained beginning to the end it had when the read started.
 *
 * A PARTIAL READ MUST NOT BECOME A VERDICT: every id it missed would be reported unpublished.
 * So a read that cannot reach the end within `timeoutMs` throws instead of answering.
 */
export async function readPublishedMessageIds(
  kafka: Kafka,
  topic: string,
  timeoutMs = 30_000,
): Promise<ReadonlySet<string>> {
  const admin = kafka.admin();
  await admin.connect();

  const groupId = `outbox-reconcile-${randomUUID()}`;
  const consumer = kafka.consumer({ groupId });
  const ids = new Set<string>();

  try {
    const lastOffsetByPartition = new Map<number, bigint>();
    for (const { partition, high, low } of await admin.fetchTopicOffsets(topic)) {
      if (BigInt(high) > BigInt(low)) lastOffsetByPartition.set(partition, BigInt(high) - 1n);
    }
    if (lastOffsetByPartition.size === 0) return ids;

    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`could not read ${topic} to its end within ${timeoutMs} ms`)),
        timeoutMs,
      );
      const markRead = (partition: number, offset: bigint): void => {
        const last = lastOffsetByPartition.get(partition);
        if (last !== undefined && offset >= last) lastOffsetByPartition.delete(partition);
        if (lastOffsetByPartition.size === 0) {
          clearTimeout(timer);
          resolve();
        }
      };
      void consumer
        .run({
          eachMessage: ({ partition, message }) => {
            const messageId = message.headers?.['message-id'];
            if (messageId !== undefined) ids.add(messageId.toString());
            markRead(partition, BigInt(message.offset));
            return Promise.resolve();
          },
        })
        .catch(reject);
    });

    return ids;
  } finally {
    await consumer.disconnect();
    await admin.deleteGroups([groupId]).catch(() => undefined);
    await admin.disconnect();
  }
}
