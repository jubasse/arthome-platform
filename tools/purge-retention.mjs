#!/usr/bin/env node
// The retention job data-model.md §7.5 specifies and nothing ran.
//
// IT IS A COMMAND, NOT A SCHEDULE. There is no job runner in this repository, so this is
//   what a cron entry or a Kubernetes CronJob invokes once the deployment exists. Leaving it
//   unscheduled is visible; leaving it unwritten was not.
//
//   Usage: NODE_ENV=development node tools/purge-retention.mjs <service> [--apply]
//   Without `--apply` it reports what it would delete and deletes nothing.

import {
  OUTBOX_RETENTION_DAYS,
  PROCESSED_MESSAGE_RETENTION_DAYS,
  purgeOutbox,
  purgeProcessedMessages,
} from '@arthome-platform/messaging';

const PUBLISHERS = new Set(['identity', 'catalog']);
const CONSUMERS = new Set(['notifications', 'search-indexer']);

const [service, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');

if (!PUBLISHERS.has(service) && !CONSUMERS.has(service)) {
  console.error(
    `usage: node tools/purge-retention.mjs <${[...PUBLISHERS, ...CONSUMERS].join('|')}> [--apply]`,
  );
  process.exit(2);
}

const { dataSource } = await import(`../apps/${service}/dist/data-source.js`);
// Same logger rebuild as ops-check.mjs: `logging: false` alone is a no-op.
dataSource.setOptions({ logger: 'advanced-console', logging: false });
await dataSource.initialize();

try {
  if (PUBLISHERS.has(service)) {
    // The slot name is the connector's, from data-model.md §7.4. A different one reads as
    //   "no connector has ever published this", and the purge refuses — which is the safe way
    //   round for a typo.
    const slot = `arthome_${service}_outbox`;
    if (apply) {
      const outcome = await purgeOutbox(dataSource, slot);
      console.log(
        outcome.refusedBecauseConnectorLagged
          ? `outbox_event: REFUSED — ${slot} lag ${outcome.lagBytes ?? 'unknown'} bytes, or inactive`
          : `outbox_event: ${outcome.deleted} row(s) deleted, lag ${outcome.lagBytes} bytes`,
      );
    } else {
      const [state] = await dataSource.query(
        `SELECT active, confirmed_flush_lsn IS NULL AS unconfirmed,
                pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::bigint AS lag
           FROM pg_replication_slots WHERE slot_name = $1`,
        [slot],
      );
      const [{ count }] = await dataSource.query(
        `SELECT count(*)::int AS count FROM outbox_event WHERE created_at < now() - ($1 || ' days')::interval`,
        [String(OUTBOX_RETENTION_DAYS)],
      );
      console.log(
        `outbox_event: ${count} row(s) past ${OUTBOX_RETENTION_DAYS} days; ${slot} ${
          state === undefined ? 'absent' : `active=${state.active} lag=${state.lag}`
        }`,
      );
    }
  }

  if (CONSUMERS.has(service)) {
    if (apply) {
      console.log(`processed_message: ${await purgeProcessedMessages(dataSource)} row(s) deleted`);
    } else {
      const [{ count }] = await dataSource.query(
        `SELECT count(*)::int AS count FROM processed_message WHERE processed_at < now() - ($1 || ' days')::interval`,
        [String(PROCESSED_MESSAGE_RETENTION_DAYS)],
      );
      console.log(
        `processed_message: ${count} row(s) past ${PROCESSED_MESSAGE_RETENTION_DAYS} days`,
      );
    }
  }
} finally {
  await dataSource.destroy();
}
