import { createHmac } from 'node:crypto';

import { readBetterAuthSecret } from '@arthome-platform/config';
import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Pool } from 'pg';
import { DataSource } from 'typeorm';

import { Service, SystemClock } from '@arthome/core';

import { Account } from './account.entity.js';
import { AuthController } from './auth.controller.js';
import { AUTH_POOL, BETTER_AUTH, FINGERPRINT_KEY } from './auth.tokens.js';
import { createAuth } from './better-auth.js';
import { EmailVerification } from './email-verification.entity.js';
import { EmailVerificationsService } from './email-verifications.service.js';
import { SessionsService } from './sessions.service.js';
import { SignInService } from './sign-in.service.js';
import { SignUpService } from './sign-up.service.js';
import { ViewerService } from './viewer.service.js';
import { CLOCK } from '../clock.js';

/** Closed on shutdown, as TypeORM's own pool is: otherwise SIGTERM leaves its connections open. */
@Injectable()
class AuthPoolLifecycle implements OnApplicationShutdown {
  public constructor(@Inject(AUTH_POOL) private readonly pool: Pool) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

/** The database TypeORM was given, so a suite's database reaches better-auth too. */
function databaseUrlOf(dataSource: DataSource): string {
  const { url } = dataSource.options as { readonly url?: string };
  if (url === undefined) throw new Error('identity reaches its database through a URL');
  return url;
}

@Module({
  imports: [TypeOrmModule.forFeature([Account, EmailVerification])],
  controllers: [AuthController],
  providers: [
    {
      provide: AUTH_POOL,
      inject: [DataSource],
      useFactory: (dataSource: DataSource): Pool =>
        new Pool({
          connectionString: databaseUrlOf(dataSource),
          // Sign-up and sign-in only: TypeORM's pool carries everything else.
          max: 5,
          connectionTimeoutMillis: 10_000,
          application_name: Service.IDENTITY,
        }),
    },
    {
      provide: BETTER_AUTH,
      inject: [AUTH_POOL],
      useFactory: (pool: Pool) => createAuth(pool, readBetterAuthSecret()),
    },
    // Derived rather than reused: one secret, one purpose.
    {
      provide: FINGERPRINT_KEY,
      useFactory: (): string =>
        createHmac('sha256', readBetterAuthSecret())
          .update('idempotency fingerprint')
          .digest('hex'),
    },
    { provide: CLOCK, useValue: new SystemClock() },
    AuthPoolLifecycle,
    SignUpService,
    SignInService,
    SessionsService,
    EmailVerificationsService,
    ViewerService,
  ],
})
export class AuthModule {}
