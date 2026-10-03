import {
  AllowInProduction,
  DEADLINE_HEADER,
  Endpoint,
  remainingBeforeDeadline,
  type PerishableResponse,
} from '@arthome-platform/http-edge';
import { Controller, Header, Headers, Inject, Param } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { storefrontApi } from '@arthome/contracts/storefront-api';
import type { Clock } from '@arthome/core';
import { DateIdSchema } from '@arthome/core/schema';

import type { DateAvailability } from './date-availability.js';
import { GetDateAvailability } from './get-date-availability.query.js';
import { CLOCK } from '../clock.js';

const { refreshDateAvailability } = storefrontApi.routes;

/**
 * The storefront's public read, behind its BFF, which sets the cache headers: `public, max-age=15`
 *   for an anonymous caller (the operation's `x-arthome-freshness`, transport.md §5.9).
 */
@AllowInProduction()
@Controller()
export class AvailabilityController {
  public constructor(
    private readonly queries: QueryBus,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Endpoint(refreshDateAvailability)
  @Header('cache-control', 'no-store')
  public availability(
    @Param('dateId', { schema: DateIdSchema }) dateId: string,
    @Headers(DEADLINE_HEADER) deadline: string | undefined,
  ): Promise<PerishableResponse<DateAvailability>> {
    remainingBeforeDeadline(deadline, this.clock);
    return this.queries.execute(new GetDateAvailability(dateId));
  }
}
