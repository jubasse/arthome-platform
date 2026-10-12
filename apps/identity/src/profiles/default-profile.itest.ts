import { randomUUID } from 'node:crypto';

import {
  applyMigrations,
  createDatabase,
  startStack,
  type MigrationPlan,
  type StartedStack,
} from '@arthome-platform/testing';
import type { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Locale } from '@arthome/core';

import { defaultProfileOf } from './default-profile.js';
import { IDENTITY_SCHEMA } from '../itest/schema.js';
import { ProfilesAndDevices1791800000000 } from '../migrations/1791800000000-profiles-and-devices.js';

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;

let stack: StartedStack;
let dataSource: DataSource;

/** Every migration before this PRD's, so accounts can exist before the backfill runs. */
const BEFORE_PROFILES: MigrationPlan = {
  entities: IDENTITY_SCHEMA.entities,
  migrations: Object.values(IDENTITY_SCHEMA.migrations).filter(
    (migration) => migration !== ProfilesAndDevices1791800000000,
  ),
};

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'identity_default_profile_itest');
  dataSource = await applyMigrations(database, BEFORE_PROFILES);
}, STARTUP_MS);

afterAll(async () => {
  await dataSource?.destroy();
  await stack?.stop();
});

async function insertAccount(handle: string): Promise<string> {
  const id = uuidv7();
  await dataSource.query(
    `INSERT INTO account (id, public_handle, email, locale, country)
     VALUES ($1, $2, $3, $4, 'FR')`,
    [id, handle, `${handle.slice(1)}@example.test`, Locale.FR],
  );
  return id;
}

async function runProfilesMigration(): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();
  try {
    await new ProfilesAndDevices1791800000000().up(queryRunner);
  } finally {
    await queryRunner.release();
  }
}

async function profilesOf(
  accountId: string,
): Promise<{ id: string; name: string; kind: string; is_default: boolean }[]> {
  return dataSource.query('SELECT id, name, kind, is_default FROM profile WHERE account_id = $1', [
    accountId,
  ]);
}

describe('the default profile', () => {
  it(
    'is backfilled once for every account, named after its handle; a second up inserts nothing',
    async () => {
      const first = await insertAccount('@viewer.backfill1');
      const second = await insertAccount('@viewer.backfill2');

      await runProfilesMigration();
      expect(await profilesOf(first)).toEqual([
        {
          id: expect.any(String) as unknown,
          name: '@viewer.backfill1',
          kind: 'adult',
          is_default: true,
        },
      ]);
      expect(await profilesOf(second)).toHaveLength(1);

      const [before] = await dataSource.query<{ count: string }[]>('SELECT count(*) FROM profile');
      await runProfilesMigration();
      const [after] = await dataSource.query<{ count: string }[]>('SELECT count(*) FROM profile');
      expect(after).toEqual(before);
    },
    CASE_MS,
  );

  it(
    'is created once when missing, however many callers race for it',
    async () => {
      await runProfilesMigration();
      const accountId = await insertAccount(`@viewer.race${randomUUID().slice(0, 8)}`);
      const profiles = await Promise.all(
        Array.from({ length: 5 }, () =>
          dataSource.transaction((manager) => defaultProfileOf(manager, accountId, 'Marie J.')),
        ),
      );

      expect(new Set(profiles.map(({ id }) => id)).size).toBe(1);
      expect(profiles[0]).toEqual({
        id: expect.any(String) as unknown,
        name: 'Marie J.',
        kind: 'adult',
      });
      expect(await profilesOf(accountId)).toHaveLength(1);
    },
    CASE_MS,
  );

  it(
    'is read back, never renamed, once it exists',
    async () => {
      await runProfilesMigration();
      const accountId = await insertAccount('@viewer.named');
      const created = await dataSource.transaction((manager) =>
        defaultProfileOf(manager, accountId),
      );
      const again = await dataSource.transaction((manager) =>
        defaultProfileOf(manager, accountId, 'Another name'),
      );
      expect(created.name).toBe('@viewer.named');
      expect(again).toEqual(created);
    },
    CASE_MS,
  );
});
