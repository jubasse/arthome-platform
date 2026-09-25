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
    // ⚠ It refuses EVERY route, so a liveness probe will need an exemption.
    {
      provide: APP_GUARD,
      useFactory: (): DenyInProductionGuard => new DenyInProductionGuard(isProductionEnvironment()),
    },
  ],
})
export class AppModule {}
