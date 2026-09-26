import { isProductionEnvironment } from '@arthome-platform/config';
import {
  DenyInProductionGuard,
  ErrorEnvelopeFilter,
  HealthController,
  READINESS_CHECKS,
  SuccessEnvelopeInterceptor,
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

import { SystemClock } from '@arthome/core';

import { SearchModule } from './search/search.module.js';
import { TraceparentMiddleware } from './traceparent.middleware.js';

@Module({
  controllers: [HealthController],
  imports: [SearchModule],
  providers: [
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
    // Not production-ready: it mints no service token, and the services it calls refuse every
    // request in production for the same reason.
    {
      provide: APP_GUARD,
      inject: [Reflector],
      useFactory: (reflector: Reflector): DenyInProductionGuard =>
        new DenyInProductionGuard(isProductionEnvironment(), reflector),
    },
    // Nothing downstream: a catalog outage fails the searches, not the BFF's place in rotation.
    { provide: READINESS_CHECKS, useValue: [] satisfies ReadinessCheck[] },
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceparentMiddleware).forRoutes('*path');
  }
}
