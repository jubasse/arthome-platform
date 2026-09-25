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

import { dataSource } from './data-source.js';
import { IdentityModule } from './identity/identity.module.js';
import { UNIQUE_VIOLATION_CODES } from './unique-violations.js';

@Module({
  imports: [TypeOrmModule.forRoot(dataSource.options), IdentityModule],
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
     */
    {
      provide: APP_FILTER,
      inject: [HttpAdapterHost],
      useFactory: (adapterHost: HttpAdapterHost): ErrorEnvelopeFilter =>
        new ErrorEnvelopeFilter(adapterHost, new SystemClock(), UNIQUE_VIOLATION_CODES),
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
