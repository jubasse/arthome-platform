import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import { DataSource } from 'typeorm';

import type { Service } from '@arthome/core';

import type { ConnectEndpoint, PostgresEndpoint } from './stack.js';

interface ConnectorDefinition {
  readonly name: string;
  readonly config: Readonly<Record<string, string>>;
}

interface ConnectorStatus {
  readonly connector: { readonly state: string; readonly trace?: string };
  readonly tasks: readonly { readonly state: string; readonly trace?: string }[];
}

/** Resolved from this module, as `compose.yaml` is in `stack.ts`. */
const CONNECTORS = new URL('../../../infra/debezium/', import.meta.url);

const DEFAULT_REGISTRATION_MS = 90_000;
const POLL_MS = 250;

/**
 * Posts `infra/debezium/<service>-outbox.json` as committed, but for its database: the suite's
 *   own, on the stack's Postgres as Connect reaches it inside Docker. Returns the connector's name
 *   once its slot streams, so a row committed afterwards reaches its topic. A task that fails
 *   throws with its trace rather than waiting out the timeout.
 */
export async function registerOutboxConnector(
  connect: ConnectEndpoint,
  service: Service,
  database: PostgresEndpoint,
  timeoutMs: number = DEFAULT_REGISTRATION_MS,
): Promise<string> {
  const committed = JSON.parse(
    readFileSync(new URL(`${service}-outbox.json`, CONNECTORS), 'utf8'),
  ) as ConnectorDefinition;
  const slotName = committed.config['slot.name'];
  if (slotName === undefined) throw new Error(`${committed.name} names no slot.name`);
  const config = {
    ...committed.config,
    'database.hostname': connect.postgresHostInsideNetwork,
    'database.port': String(connect.postgresPortInsideNetwork),
    'database.dbname': database.database,
  };

  const posted = await fetch(`${connect.url}/connectors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: committed.name, config }),
  });
  if (!posted.ok) {
    throw new Error(
      `Kafka Connect refused ${committed.name}: ${posted.status} ${await posted.text()}`,
    );
  }

  const deadline = Date.now() + timeoutMs;
  await waitForRunningTask(connect, committed.name, deadline);
  await waitForActiveSlot(database, slotName, deadline);
  return committed.name;
}

async function waitForRunningTask(
  connect: ConnectEndpoint,
  name: string,
  deadline: number,
): Promise<void> {
  let last = 'no status yet';
  while (Date.now() < deadline) {
    const answer = await fetch(`${connect.url}/connectors/${name}/status`);
    if (answer.ok) {
      const status = (await answer.json()) as ConnectorStatus;
      const failed = [status.connector, ...status.tasks].find(({ state }) => state === 'FAILED');
      if (failed !== undefined) {
        throw new Error(`connector ${name} failed: ${failed.trace ?? '(no trace)'}`);
      }
      if (status.tasks.length > 0 && status.tasks.every(({ state }) => state === 'RUNNING')) {
        return;
      }
      last = JSON.stringify(status);
    }
    await delay(POLL_MS);
  }
  throw new Error(`connector ${name} has no running task in time: ${last}`);
}

/**
 * A task reports RUNNING before Debezium has created its slot: a row committed in between is in
 *   no slot's stream, and never reaches its topic.
 */
async function waitForActiveSlot(
  database: PostgresEndpoint,
  slotName: string,
  deadline: number,
): Promise<void> {
  const dataSource = new DataSource({ type: 'postgres', url: database.url, logging: false });
  await dataSource.initialize();
  try {
    while (Date.now() < deadline) {
      const slots = await dataSource.query<{ active: boolean }[]>(
        'SELECT active FROM pg_replication_slots WHERE slot_name = $1 AND database = $2',
        [slotName, database.database],
      );
      if (slots[0]?.active === true) return;
      await delay(POLL_MS);
    }
  } finally {
    await dataSource.destroy();
  }
  throw new Error(`slot ${slotName} on ${database.database} is not streaming in time`);
}
