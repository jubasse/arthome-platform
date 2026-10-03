import { AsyncLocalStorage } from 'node:async_hooks';

import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { bearer } from 'better-auth/plugins/bearer';
import { PostgresDialect } from 'kysely';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { SESSION_LIFETIME_SECONDS, SESSION_RENEWAL_AGE_SECONDS } from '@arthome/core';

import { hashPassword, verifyPassword } from './password-hashing.js';

/** `adr-auth.md` R2: better-auth's tables in their own schema, TypeORM's in `public`. */
export const AUTH_SCHEMA = 'auth';

/** The contract's floor (`signUp`), and better-auth's own ceiling. */
export const PASSWORD_LENGTH = { min: 12, max: 128 } as const;

const presetUserIds = new AsyncLocalStorage<string>();

/**
 * Runs `create` so the user better-auth inserts takes `userId`: the account's id, written first
 *   in identity's own transaction, so one UUIDv7 names both (R2, "the domain holds only a
 *   `user_id`").
 */
export function withPresetUserId<T>(userId: string, create: () => Promise<T>): Promise<T> {
  return presetUserIds.run(userId, create);
}

/**
 * better-auth as a library: identity's controllers call `auth.api`, and no better-auth route is
 *   mounted, so none escapes the internal token's guard (`adr-auth.md` §3.1). The session token it
 *   hands out is the signed one the `bearer` plugin reads back, and an unsigned one is refused.
 */
export function authOptions(pool: Pool, secret: string) {
  return {
    secret,
    database: {
      dialect: new PostgresDialect({ pool }),
      type: 'postgres' as const,
      schemaName: AUTH_SCHEMA,
      transaction: true,
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: PASSWORD_LENGTH.min,
      maxPasswordLength: PASSWORD_LENGTH.max,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    session: { expiresIn: SESSION_LIFETIME_SECONDS, updateAge: SESSION_RENEWAL_AGE_SECONDS },
    advanced: {
      database: {
        generateId: ({ model }: { readonly model: string }): string =>
          (model === 'user' ? presetUserIds.getStore() : undefined) ?? uuidv7(),
      },
    },
    plugins: [bearer({ requireSignature: true })],
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
}

export function createAuth(pool: Pool, secret: string) {
  return betterAuth(authOptions(pool, secret));
}

export type Auth = ReturnType<typeof createAuth>;
