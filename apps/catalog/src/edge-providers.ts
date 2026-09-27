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
import { UNIQUE_VIOLATION_CODES } from './unique-violations.js';

/**
 * The service's global enhancers, bound by `AppModule` and by the HTTP suites
 *   (`itest/http-app.ts`), so a suite answers what the service answers.
 */
export const EDGE_PROVIDERS: Provider[] = [
  /**
   * A schema on a `@Body()` parameter is metadata: without this pipe reading it, nothing
   *   validates. Global rather than `@UsePipes` on a method, where the schema would run on
   *   every parameter of the handler, `@Param('id')` included.
   */
  {
    provide: APP_PIPE,
    useValue: new StandardSchemaValidationPipe({ exceptionFactory: schemaInvalidException }),
  },
  /**
   * `useFactory` rather than `useGlobalFilters`, which cannot inject the `HttpAdapterHost`
   *   this filter replies through. Adding a `UNIQUE` to this schema means adding its code
   *   to `UNIQUE_VIOLATION_CODES` too, or the violation answers 500.
   */
  {
    provide: APP_FILTER,
    inject: [HttpAdapterHost, CLOCK],
    useFactory: (adapterHost: HttpAdapterHost, clock: Clock): ErrorEnvelopeFilter =>
      new ErrorEnvelopeFilter(adapterHost, clock, UNIQUE_VIOLATION_CODES),
  },
  // §5.5's envelope on the success path, symmetric with the filter on the error path: both
  // take the `Clock` rather than reading the machine's time.
  {
    provide: APP_INTERCEPTOR,
    inject: [CLOCK],
    useFactory: (clock: Clock): SuccessEnvelopeInterceptor => new SuccessEnvelopeInterceptor(clock),
  },
  /** It refuses EVERY route, so a liveness probe will need an exemption. */
  {
    provide: APP_GUARD,
    inject: [Reflector],
    useFactory: (reflector: Reflector): DenyInProductionGuard =>
      new DenyInProductionGuard(isProductionEnvironment(), reflector),
  },
  { provide: CLOCK, useValue: new SystemClock() },
];
