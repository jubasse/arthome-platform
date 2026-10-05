import { readBetterAuthSecret } from '@arthome-platform/config';
import {
  applyMigrations,
  createDatabase,
  httpApp,
  mintInternalToken,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Pool } from 'pg';
import type { DataSource } from 'typeorm';

import { Service, type FixedClock } from '@arthome/core';

import { IDENTITY_SCHEMA } from './schema.js';
import { migrateAuthSchema } from '../auth/auth-migrations.js';
import { AuthModule } from '../auth/auth.module.js';
import { CLOCK } from '../clock.js';
import { EDGE_PROVIDERS } from '../edge-providers.js';

export interface IdentityHarness {
  readonly stack: StartedStack;
  readonly dataSource: DataSource;
  readonly app: NestFastifyApplication;
  close(): Promise<void>;
}

/**
 * Identity's API over HTTP on its own database, both schemas migrated, the BFF's calls signed on
 *   the suite's clock: anonymous unless a request carries its own token.
 */
export async function startIdentity(name: string, clock: FixedClock): Promise<IdentityHarness> {
  const stack = await startStack({ postgres: true, startupTimeoutMs: 240_000 });
  const database = await createDatabase(stack.postgres, name);
  const dataSource = await applyMigrations(database, IDENTITY_SCHEMA);
  const pool = new Pool({ connectionString: database.url });
  try {
    await migrateAuthSchema(pool, readBetterAuthSecret({ NODE_ENV: 'test' }));
  } finally {
    await pool.end();
  }
  const app = await httpApp({
    imports: [AuthModule],
    providers: EDGE_PROVIDERS,
    dataSource,
    overrides: [[CLOCK, clock]],
    caller: { service: Service.IDENTITY, clock },
  });
  return {
    stack,
    dataSource,
    app,
    close: async () => {
      await app.close();
      await stack.stop();
    },
  };
}

/** The `authorization` header the BFF sends when it calls identity for `accountId`. */
export async function asAccount(clock: FixedClock, accountId: string): Promise<string> {
  return `Bearer ${await mintInternalToken({ service: Service.IDENTITY, clock, accountId })}`;
}
