import { readBetterAuthSecret } from '@arthome-platform/config';
import {
  applyMigrations,
  createDatabase,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Locale } from '@arthome/core';

import { migrateAuthSchema } from './auth-migrations.js';
import { AUTH_SCHEMA, createAuth, withPresetUserId } from './better-auth.js';
import { IDENTITY_SCHEMA } from '../itest/schema.js';

/**
 * `adr-auth.md` §11, spike S1, kept as a regression: better-auth on Kysely in `auth`, TypeORM in
 *   `public`, one database, either migration first, one UUIDv7 naming the account in both.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 60_000;
const SECRET = readBetterAuthSecret({ NODE_ENV: 'test' });
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let stack: StartedStack;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
}, STARTUP_MS);

afterAll(async () => {
  await stack?.stop();
});

/** TypeORM's, `public` unless the connection says otherwise. */
async function currentSchemaOf(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ schema: string }>('SELECT current_schema() AS schema');
  return rows[0]?.schema ?? '';
}

async function tablesIn(pool: Pool, schema: string): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1',
    [schema],
  );
  return rows.map(({ table_name }) => table_name);
}

describe('the two schemas on one database', () => {
  it(
    'migrate in either order, and a second auth migration changes nothing',
    async () => {
      for (const [name, authFirst] of [
        ['identity_s1_typeorm_first', false],
        ['identity_s1_auth_first', true],
      ] as const) {
        const database = await createDatabase(stack.postgres, name);
        const pool = new Pool({ connectionString: database.url });
        try {
          if (authFirst) await migrateAuthSchema(pool, SECRET);
          await (await applyMigrations(database, IDENTITY_SCHEMA)).destroy();
          if (!authFirst) await migrateAuthSchema(pool, SECRET);

          expect(await tablesIn(pool, AUTH_SCHEMA)).toEqual(
            expect.arrayContaining(['account', 'session', 'user', 'verification']),
          );
          const typeOrmSchema = await currentSchemaOf(pool);
          expect(await tablesIn(pool, typeOrmSchema)).toEqual(
            expect.arrayContaining(['account', 'email_verification', 'outbox_event']),
          );
          expect(await tablesIn(pool, typeOrmSchema)).not.toContain('user');

          const before = await tablesIn(pool, AUTH_SCHEMA);
          await migrateAuthSchema(pool, SECRET);
          expect(await tablesIn(pool, AUTH_SCHEMA)).toEqual(before);
        } finally {
          await pool.end();
        }
      }
    },
    CASE_MS,
  );

  it(
    'names the account and its credential with one UUIDv7, which a join across the two reads',
    async () => {
      const database = await createDatabase(stack.postgres, 'identity_s1_join');
      const pool = new Pool({ connectionString: database.url });
      const dataSource = await applyMigrations(database, IDENTITY_SCHEMA);
      try {
        await migrateAuthSchema(pool, SECRET);
        const auth = createAuth(pool, SECRET);
        const accountId = '019a0000-0000-7000-8000-000000005151';
        await dataSource.query(
          `INSERT INTO account (id, public_handle, email, locale, country)
           VALUES ($1, '@viewer.s1s1s1s1', 'joined@example.test', $2, 'FR')`,
          [accountId, Locale.FR],
        );

        const created = await withPresetUserId(accountId, () =>
          auth.api.signUpEmail({
            body: { email: 'joined@example.test', password: 'a-long-password', name: '' },
          }),
        );

        expect(created.user.id).toBe(accountId);
        const { rows: sessions } = await pool.query<{ id: string }>(
          `SELECT id FROM ${AUTH_SCHEMA}.session WHERE "userId" = $1`,
          [accountId],
        );
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.id).toMatch(UUID_V7);

        const { rows: joined } = await pool.query<{ public_handle: string }>(
          `SELECT a.public_handle
             FROM account a
             JOIN ${AUTH_SCHEMA}."user" u ON u.id = a.id::text`,
        );
        expect(joined).toEqual([{ public_handle: '@viewer.s1s1s1s1' }]);

        const { rows: hashes } = await pool.query<{ password: string }>(
          `SELECT password FROM ${AUTH_SCHEMA}.account WHERE "userId" = $1`,
          [accountId],
        );
        expect(hashes[0]?.password).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
      } finally {
        await dataSource.destroy();
        await pool.end();
      }
    },
    CASE_MS,
  );
});
