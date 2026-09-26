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

import { CatalogModule } from './catalog/catalog.module.js';
import { dataSource } from './data-source.js';

@Module({
  controllers: [HealthController],
  imports: [TypeOrmModule.forRoot(dataSource.options), CatalogModule],
  providers: [
    /**
     * ⚠ A schema on a `@Body()` parameter is metadata: without this pipe reading it, nothing
     *   validates. Global rather than `@UsePipes` on a method, where the schema would run on
     *   every parameter of the handler, `@Param('id')` included.
     */
    {
      provide: APP_PIPE,
      useValue: new StandardSchemaValidationPipe({ exceptionFactory: schemaInvalidException }),
    },
    /**
     * ⚠ `useFactory` rather than `useGlobalFilters`, which cannot inject the `HttpAdapterHost`
     *   this filter replies through. Adding a `UNIQUE` to this schema means adding its code
     *   here too, or the violation answers 500.
     */
    {
      provide: APP_FILTER,
      inject: [HttpAdapterHost],
      useFactory: (adapterHost: HttpAdapterHost): ErrorEnvelopeFilter =>
        new ErrorEnvelopeFilter(adapterHost, new SystemClock()),
    },
    // §5.5's envelope on the success path, symmetric with the filter on the error path: both
    // take the `Clock` rather than reading the machine's time.
    {
      provide: APP_INTERCEPTOR,
      useFactory: (): SuccessEnvelopeInterceptor =>
        new SuccessEnvelopeInterceptor(new SystemClock()),
    },
    /** ⚠ It refuses EVERY route, so a liveness probe will need an exemption. */
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
        () => checkReplicationSlot(dataSource, outboxSlotName(Service.CATALOG)),
        () => checkPublicationScope(dataSource, outboxSlotName(Service.CATALOG)),
        () => checkOutboxRetention(dataSource),
      ],
    },
  ],
})
export class AppModule {}
