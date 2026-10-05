import { isProductionEnvironment } from '@arthome-platform/config';
import {
  DenyInProductionGuard,
  ErrorEnvelopeFilter,
  HealthController,
  JsonBodiesOnly,
  READINESS_CHECKS,
  SuccessEnvelopeInterceptor,
  endpointProviders,
  schemaInvalidException,
  type ReadinessCheck,
} from '@arthome-platform/http-edge';
import {
  Module,
  StandardSchemaValidationPipe,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  HttpAdapterHost,
  Reflector,
} from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

import { SystemClock } from '@arthome/core';

import { AuthThrottlerGuard, ThrottleRule, authThrottlers } from './auth/auth-rate-limits.js';
import { AuthModule } from './auth/auth.module.js';
import {
  THROTTLER_REDIS,
  ThrottlerRedisModule,
  throttlerStorage,
} from './auth/throttler-storage.js';
import { CLOCK } from './clock.js';
import { DatesModule } from './dates/dates.module.js';
import { authEnv } from './env.js';
import { IdentityModule } from './identity/identity.module.js';
import { SearchModule } from './search/search.module.js';
import { CsrfGuard } from './session/csrf.guard.js';
import { CSRF_SECRET, EdgePlugins } from './session/edge-plugins.js';
import { ViewerOrDeviceIdentity } from './session/viewer-or-device.identity.js';
import { ViewerGuard } from './session/viewer.guard.js';
import { ViewerIdentity } from './session/viewer.identity.js';
import { TraceparentMiddleware } from './traceparent.middleware.js';

@Module({
  controllers: [HealthController],
  imports: [
    SearchModule,
    DatesModule,
    IdentityModule,
    AuthModule,
    ThrottlerModule.forRootAsync({
      imports: [ThrottlerRedisModule],
      inject: [Reflector, THROTTLER_REDIS],
      useFactory: (reflector: Reflector, redis: Redis) => ({
        throttlers: authThrottlers(reflector),
        storage: throttlerStorage(redis),
      }),
    }),
  ],
  providers: [
    ...endpointProviders({
      inject: [ViewerIdentity, ViewerOrDeviceIdentity, ThrottleRule],
      useFactory: (
        viewer: ViewerIdentity,
        viewerOrDevice: ViewerOrDeviceIdentity,
        throttle: ThrottleRule,
      ) => ({
        identities: { viewer, viewer_or_device: viewerOrDevice },
        rules: { throttle },
      }),
    }),
    ViewerIdentity,
    ViewerOrDeviceIdentity,
    ThrottleRule,
    AuthThrottlerGuard,
    {
      provide: APP_PIPE,
      useValue: new StandardSchemaValidationPipe({ exceptionFactory: schemaInvalidException }),
    },
    {
      provide: APP_FILTER,
      inject: [HttpAdapterHost],
      useFactory: (adapterHost: HttpAdapterHost): ErrorEnvelopeFilter =>
        new ErrorEnvelopeFilter(adapterHost, new SystemClock()),
    },
    {
      provide: APP_INTERCEPTOR,
      useFactory: (): SuccessEnvelopeInterceptor =>
        new SuccessEnvelopeInterceptor(new SystemClock()),
    },
    // In this order: a forged write is refused before anything is resolved, the viewer is resolved
    //   before the caps that count by account, and the production guard keeps closed what no slice
    //   has opened.
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: ViewerGuard },
    { provide: APP_GUARD, useExisting: AuthThrottlerGuard },
    {
      provide: APP_GUARD,
      inject: [Reflector],
      useFactory: (reflector: Reflector): DenyInProductionGuard =>
        new DenyInProductionGuard(isProductionEnvironment(), reflector),
    },
    { provide: CLOCK, useValue: new SystemClock() },
    { provide: CSRF_SECRET, useValue: authEnv.csrfSecret },
    EdgePlugins,
    JsonBodiesOnly,
    // Nothing downstream: a catalog outage fails the searches, not the BFF's place in rotation.
    { provide: READINESS_CHECKS, useValue: [] satisfies ReadinessCheck[] },
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceparentMiddleware).forRoutes('*path');
  }
}
