import { isProductionEnvironment, readJwksSource } from '@arthome-platform/config';
import { StandardSchemaValidationPipe, type InjectionToken, type Provider } from '@nestjs/common';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  HttpAdapterHost,
  Reflector,
} from '@nestjs/core';

import { SystemClock, type Clock } from '@arthome/core';

import { DenyInProductionGuard } from './deny-in-production.guard.js';
import { ErrorEnvelopeFilter } from './error-envelope.filter.js';
import { InternalTokenGuard } from './internal-token.guard.js';
import { InternalTokenVerifier } from './internal-token.verifier.js';
import { JsonBodiesOnly } from './json-bodies-only.js';
import { schemaInvalidException, type UniqueViolationCode } from './refusal.js';
import { SuccessEnvelopeInterceptor } from './success-envelope.interceptor.js';

export interface EdgeOptions {
  /** The audience the internal token must name: a `Service` member, or a generated service's name. */
  readonly service: string;
  /** The service's token for core's `Clock`, which its feature modules inject too. */
  readonly clock: InjectionToken;
  /** Every unique constraint a request can collide on: one left out answers 500. */
  readonly uniqueViolations?: readonly UniqueViolationCode[];
}

/**
 * A service's global enhancers and its system clock, bound by its root module and by its HTTP
 *   suites (`httpApp` in `@arthome-platform/testing`), so a suite answers what the service answers.
 */
export function edgeProviders({ service, clock, uniqueViolations = [] }: EdgeOptions): Provider[] {
  return [
    // Global rather than `@UsePipes` on a method, where the schema would run on every parameter
    //   of the handler, `@Param('id')` included.
    {
      provide: APP_PIPE,
      useValue: new StandardSchemaValidationPipe({ exceptionFactory: schemaInvalidException }),
    },
    // `useFactory` rather than `useGlobalFilters`, which cannot inject the `HttpAdapterHost` this
    //   filter replies through.
    {
      provide: APP_FILTER,
      inject: [HttpAdapterHost, clock],
      useFactory: (adapterHost: HttpAdapterHost, time: Clock): ErrorEnvelopeFilter =>
        new ErrorEnvelopeFilter(adapterHost, time, uniqueViolations),
    },
    {
      provide: APP_INTERCEPTOR,
      inject: [clock],
      useFactory: (time: Clock): SuccessEnvelopeInterceptor => new SuccessEnvelopeInterceptor(time),
    },
    {
      provide: InternalTokenVerifier,
      inject: [clock],
      useFactory: (time: Clock): InternalTokenVerifier =>
        new InternalTokenVerifier(service, readJwksSource(), time),
    },
    // Authentication first, then what no slice authorises yet: two global guards run in the order
    //   they are bound.
    {
      provide: APP_GUARD,
      inject: [InternalTokenVerifier, Reflector],
      useFactory: (verifier: InternalTokenVerifier, reflector: Reflector): InternalTokenGuard =>
        new InternalTokenGuard(verifier, reflector),
    },
    {
      provide: APP_GUARD,
      inject: [Reflector],
      useFactory: (reflector: Reflector): DenyInProductionGuard =>
        new DenyInProductionGuard(isProductionEnvironment(), reflector),
    },
    { provide: clock, useValue: new SystemClock() },
    { provide: JsonBodiesOnly, useClass: JsonBodiesOnly },
  ];
}
