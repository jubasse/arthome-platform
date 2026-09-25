import { isProductionEnvironment } from '@arthome-platform/config';
import {
  DenyInProductionGuard,
  ErrorEnvelopeFilter,
  schemaInvalidException,
} from '@arthome-platform/http-edge';
import { Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE, HttpAdapterHost } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SystemClock } from '@arthome/core';

import { CatalogModule } from './catalog/catalog.module.js';
import { dataSource } from './data-source.js';

@Module({
  imports: [TypeOrmModule.forRoot(dataSource.options), CatalogModule],
  providers: [
    /**
     * ⚠ A schema on a `@Body()` parameter is metadata: without this pipe reading it,
     *   nothing validates. Global rather than `@UsePipes` on a method, where the
     *   schema would run on every parameter of the handler, `@Param('id')` included.
     */
    {
      provide: APP_PIPE,
      useValue: new StandardSchemaValidationPipe({ exceptionFactory: schemaInvalidException }),
    },
    /**
     * ⚠ `useFactory` rather than `useGlobalFilters`, which cannot inject the
     *   `HttpAdapterHost` this filter replies through. `Clock` has no DI token, and
     *   passing it is what lets a `FixedClock` assert `servedAt`.
     *
     *   No unique-violation codes: nothing in this schema is unique, so the service
     *   raises no conflict. Adding a `UNIQUE` means adding its code here too, or the
     *   violation answers 500.
     */
    {
      provide: APP_FILTER,
      inject: [HttpAdapterHost],
      useFactory: (adapterHost: HttpAdapterHost): ErrorEnvelopeFilter =>
        new ErrorEnvelopeFilter(adapterHost, new SystemClock()),
    },
    /**
     * ⚠ It refuses EVERY route, so the liveness probe this service does not have yet
     *   will need an exemption — `Reflector.createDecorator`, read with
     *   `getAllAndOverride`. Not built: a decorator with no route to exempt is shape
     *   invented ahead of use.
     */
    {
      provide: APP_GUARD,
      useFactory: (): DenyInProductionGuard => new DenyInProductionGuard(isProductionEnvironment()),
    },
  ],
})
export class AppModule {}
