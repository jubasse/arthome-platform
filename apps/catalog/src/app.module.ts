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
    /** ⚠ It refuses EVERY route, so a liveness probe will need an exemption. */
    {
      provide: APP_GUARD,
      useFactory: (): DenyInProductionGuard => new DenyInProductionGuard(isProductionEnvironment()),
    },
  ],
})
export class AppModule {}
