import { isProductionEnvironment } from '@arthome-platform/config';
import {
  DenyInProductionGuard,
  ErrorEnvelopeFilter,
  SuccessEnvelopeInterceptor,
  schemaInvalidException,
} from '@arthome-platform/http-edge';
import { StandardSchemaValidationPipe, type Provider } from '@nestjs/common';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  HttpAdapterHost,
  Reflector,
} from '@nestjs/core';

import { SystemClock, type Clock } from '@arthome/core';

import { CLOCK } from './clock.js';

/**
 * The service's global enhancers, bound by `AppModule` and by the HTTP suites
 *   (`itest/http-app.ts`), so a suite answers what the service answers.
 */
export const EDGE_PROVIDERS: Provider[] = [
  // Global, not `@UsePipes` on a method, where the schema would run on every parameter.
  {
    provide: APP_PIPE,
    useValue: new StandardSchemaValidationPipe({ exceptionFactory: schemaInvalidException }),
  },
  // No unique constraint a request can collide on: `date_sales` is keyed by catalog's date id,
  //   and only the consumer inserts it. A new one adds its code here, or it answers 500.
  {
    provide: APP_FILTER,
    inject: [HttpAdapterHost, CLOCK],
    useFactory: (adapterHost: HttpAdapterHost, clock: Clock): ErrorEnvelopeFilter =>
      new ErrorEnvelopeFilter(adapterHost, clock, []),
  },
  {
    provide: APP_INTERCEPTOR,
    inject: [CLOCK],
    useFactory: (clock: Clock): SuccessEnvelopeInterceptor => new SuccessEnvelopeInterceptor(clock),
  },
  {
    provide: APP_GUARD,
    inject: [Reflector],
    useFactory: (reflector: Reflector): DenyInProductionGuard =>
      new DenyInProductionGuard(isProductionEnvironment(), reflector),
  },
  { provide: CLOCK, useValue: new SystemClock() },
];
