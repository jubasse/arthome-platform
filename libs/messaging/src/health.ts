import type { Admin } from 'kafkajs';
import type { DataSource } from 'typeorm';

import { findUnpublishedOutboxRows, type PublishedIdsReader } from './republish.js';
import { MAX_SLOT_LAG_BYTES, readSlotState } from './slot.js';

export type CheckStatus = 'up' | 'degraded' | 'down';

type Detail = Readonly<Record<string, string | number | boolean | null>>;

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: Detail;
}

const CHECK_TIMEOUT_MS = 2_000;

/**
 * A failure or a timeout becomes a result, never a throw: a rejection escaping a probe answers
 * 500, which reads as "this process is broken" when the truth was "that dependency is".
 */
export async function boundedCheck(
  name: string,
  onFailure: 'down' | 'degraded',
  attempt: () => Promise<{ readonly status: CheckStatus; readonly detail: Detail }>,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<CheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const { status, detail } = await Promise.race([attempt(), timeout]);
    return { name, status, detail };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name, status: onFailure, detail: { error: message } };
  } finally {
    clearTimeout(timer);
  }
}

/** The only check allowed to answer `down`: without its database this instance serves nothing. */
export function checkDatabaseReachable(dataSource: DataSource): Promise<CheckResult> {
  return boundedCheck('database', 'down', async () => {
    await dataSource.query('SELECT 1');
    return { status: 'up', detail: {} };
  });
}

export function checkReplicationSlot(
  dataSource: DataSource,
  slotName: string,
): Promise<CheckResult> {
  return boundedCheck('replication_slot', 'degraded', async () => {
    const slot = await readSlotState(dataSource, slotName);
    if (slot === undefined)
      return { status: 'degraded', detail: { slot: slotName, present: false } };

    const healthy = slot.active && !slot.unconfirmed && slot.lagBytes <= MAX_SLOT_LAG_BYTES;
    return {
      status: healthy ? 'up' : 'degraded',
      detail: { slot: slotName, active: slot.active, lagBytes: slot.lagBytes },
    };
  });
}

/**
 * Found live on 2026-09-26: `FOR ALL TABLES`, carrying `account` and `migrations`, because the
 * connector was registered before `publication.autocreate.mode: filtered` existed. It needs
 * superuser, so it passes in development and fails on the first real deployment.
 */
export function checkPublicationScope(
  dataSource: DataSource,
  publicationName: string,
): Promise<CheckResult> {
  return boundedCheck('publication_scope', 'degraded', async () => {
    const [publication] = (await dataSource.query(
      'SELECT puballtables FROM pg_publication WHERE pubname = $1',
      [publicationName],
    )) as unknown as { puballtables: boolean }[];
    if (publication === undefined) {
      return { status: 'degraded', detail: { publication: publicationName, present: false } };
    }

    const tables = (
      (await dataSource.query(
        `SELECT schemaname || '.' || tablename AS name FROM pg_publication_tables WHERE pubname = $1`,
        [publicationName],
      )) as unknown as { name: string }[]
    ).map(({ name }) => name);

    const scoped =
      !publication.puballtables && tables.length === 1 && tables[0] === 'public.outbox_event';
    return {
      status: scoped ? 'up' : 'degraded',
      detail: {
        publication: publicationName,
        allTables: publication.puballtables,
        tables: tables.join(','),
      },
    };
  });
}

/**
 * Rows past the retention mean the purge is not running — or is refusing, because the connector
 * is behind. Either way somebody has to look.
 */
export function checkOutboxRetention(
  dataSource: DataSource,
  retentionDays = 7,
): Promise<CheckResult> {
  return rowsPastRetention(
    dataSource,
    'outbox_retention',
    'outbox_event',
    'created_at',
    retentionDays,
  );
}

export function checkProcessedMessageRetention(
  dataSource: DataSource,
  retentionDays = 30,
): Promise<CheckResult> {
  return rowsPastRetention(
    dataSource,
    'processed_message_retention',
    'processed_message',
    'processed_at',
    retentionDays,
  );
}

/**
 * Nothing consumes a dead-letter topic, so `high - low` summed over its partitions is its depth.
 * Any message there is a fact that failed and is waiting for a person.
 */
export function checkDeadLetterDepth(admin: Admin, topic: string): Promise<CheckResult> {
  return boundedCheck('dead_letter_depth', 'degraded', async () => {
    const partitions = await admin.fetchTopicOffsets(topic);
    const depth = partitions.reduce((sum, { high, low }) => sum + Number(high) - Number(low), 0);
    return { status: depth === 0 ? 'up' : 'degraded', detail: { topic, depth } };
  });
}

function rowsPastRetention(
  dataSource: DataSource,
  name: string,
  table: 'outbox_event' | 'processed_message',
  column: 'created_at' | 'processed_at',
  retentionDays: number,
): Promise<CheckResult> {
  return boundedCheck(name, 'degraded', async () => {
    const [row] = (await dataSource.query(
      `SELECT count(*)::int AS past FROM ${table} WHERE ${column} < now() - ($1 || ' days')::interval`,
      [String(retentionDays)],
    )) as unknown as { past: number }[];
    const past = row?.past ?? 0;
    return {
      status: past === 0 ? 'up' : 'degraded',
      detail: { retentionDays, rowsPastRetention: past },
    };
  });
}

/**
 * Reads whole topics: for `ops:check`, never for a readiness probe polled every few seconds.
 * Its timeout sits above the reader's own, so a slow read reports the reader's error.
 */
export function checkUnpublishedOutbox(
  dataSource: DataSource,
  readPublishedIds: PublishedIdsReader,
): Promise<CheckResult> {
  return boundedCheck(
    'unpublished_outbox',
    'degraded',
    async () => {
      const { checked, unpublished } = await findUnpublishedOutboxRows(
        dataSource,
        readPublishedIds,
      );
      return {
        status: unpublished.length === 0 ? 'up' : 'degraded',
        detail: {
          checked,
          unpublished: unpublished.length,
          ids: unpublished
            .slice(0, 5)
            .map(({ id }) => id)
            .join(','),
        },
      };
    },
    60_000,
  );
}
