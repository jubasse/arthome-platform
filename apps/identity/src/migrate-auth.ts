import { readBetterAuthSecret } from '@arthome-platform/config';
import { Pool } from 'pg';

import { Service } from '@arthome/core';

import { migrateAuthSchema } from './auth/auth-migrations.js';
import { env } from './env.js';

const pool = new Pool({ connectionString: env.DATABASE_URL, application_name: Service.IDENTITY });
try {
  await migrateAuthSchema(pool, readBetterAuthSecret());
} finally {
  await pool.end();
}
