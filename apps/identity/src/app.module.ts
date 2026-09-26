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
  checkDatabaseReachable,
  checkOutboxRetention,
  checkPublicationScope,
  checkReplicationSlot,
  outboxSlotName,
} from '@arthome-platform/messaging';
import { Module, StandardSchemaValidationPipe } from '@nestjs/common';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  HttpAdapterHost,
  Reflector,
} from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { Service, SystemClock } from '@arthome/core';

import { dataSource } from './data-source.js';
import { IdentityModule } from './identity/identity.module.js';
import { UNIQUE_VIOLATION_CODES } from './unique-violations.js';

@Module({
  controllers: [HealthController],
  imports: [TypeOrmModule.forRoot(dataSource.options), IdentityModule],
  providers: [
    // ⚠ Global, not `@UsePipes`: a schema on `@Body()` is inert without this pipe, and per
    //   method it would run on every parameter of the handler.
    {
      provide: APP_PIPE,
      useValue: new StandardSchemaValidationPipe({ exceptionFactory: schemaInvalidException }),
    },
    // `useGlobalFilters` cannot inject the `HttpAdapterHost` this filter replies through.
    {
      provide: APP_FILTER,
      inject: [HttpAdapterHost],
      useFactory: (adapterHost: HttpAdapterHost): ErrorEnvelopeFilter =>
        new ErrorEnvelopeFilter(adapterHost, new SystemClock(), UNIQUE_VIOLATION_CODES),
    },
    // §5.5's envelope on the success path, symmetric with the filter on the error path: both
    // take the `Clock` rather than reading the machine's time.
    {
      provide: APP_INTERCEPTOR,
      useFactory: (): SuccessEnvelopeInterceptor =>
        new SuccessEnvelopeInterceptor(new SystemClock()),
    },
    // ⚠ It refuses EVERY route, so a liveness probe will need an exemption.
    {
      provide: APP_GUARD,
      inject: [Reflector],
      useFactory: (reflector: Reflector): DenyInProductionGuard =>
        new DenyInProductionGuard(isProductionEnvironment(), reflector),
    },
    {
      provide: READINESS_CHECKS,
      inject: [DataSource],
      useFactory: (dataSource: DataSource): ReadinessCheck[] => [
        () => checkDatabaseReachable(dataSource),
        () => checkReplicationSlot(dataSource, outboxSlotName(Service.IDENTITY)),
        () => checkPublicationScope(dataSource, outboxSlotName(Service.IDENTITY)),
        () => checkOutboxRetention(dataSource),
      ],
    },
  ],
})
export class AppModule {}
