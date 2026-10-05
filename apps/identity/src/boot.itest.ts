import { readBetterAuthSecret } from '@arthome-platform/config';
import {
  applyMigrations,
  createDatabase,
  mintInternalToken,
  startStack,
  type StartedStack,
} from '@arthome-platform/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiErrorCode, Locale, Service, SystemClock } from '@arthome/core';

import { migrateAuthSchema } from './auth/auth-migrations.js';

/**
 * `AppModule` itself, as `main.ts` boots it: its global providers, better-auth's pool beside
 *   TypeORM's, both closed on shutdown. `DATABASE_URL` names the container, since `env.ts` reads
 *   it at import.
 */

const STARTUP_MS = 240_000;
const CASE_MS = 30_000;

let stack: StartedStack;

beforeAll(async () => {
  stack = await startStack({ postgres: true, startupTimeoutMs: STARTUP_MS });
  const database = await createDatabase(stack.postgres, 'identity_boot_itest');
  process.env.DATABASE_URL = database.url;
  const { IDENTITY_SCHEMA } = await import('./itest/schema.js');
  await (await applyMigrations(database, IDENTITY_SCHEMA)).destroy();
  const pool = new Pool({ connectionString: database.url });
  try {
    await migrateAuthSchema(pool, readBetterAuthSecret({ NODE_ENV: 'test' }));
  } finally {
    await pool.end();
  }
}, STARTUP_MS);

afterAll(async () => {
  await stack?.stop();
});

describe('the API process', () => {
  it(
    'boots AppModule, answers its probe anonymously and nothing else without a token',
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

        const anonymous = await app.inject({
          method: 'POST',
          url: '/v1/auth/sign-in',
          headers: { 'content-type': 'application/json' },
          payload: { email: 'nobody@example.test', password: 'a-long-password' },
        });
        expect(anonymous.statusCode).toBe(401);
        expect(anonymous.json()).toMatchObject({ error: { code: ApiErrorCode.UNAUTHENTICATED } });

        const signedUp = await app.inject({
          method: 'POST',
          url: '/v1/auth/sign-up',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': '019a0000-0000-7000-8000-00000000b007',
            authorization: `Bearer ${await mintInternalToken({
              service: Service.IDENTITY,
              clock: new SystemClock(),
            })}`,
          },
          payload: {
            email: 'booted@example.test',
            password: 'a-long-password',
            locale: Locale.EN,
            country: 'ZZ',
            acceptedTermsVersion: 1,
          },
        });
        expect(signedUp.statusCode).toBe(201);
      } finally {
        await app.close();
      }
    },
    CASE_MS,
  );
});
