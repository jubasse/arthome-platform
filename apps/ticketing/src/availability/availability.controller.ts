import {
  AllowInProduction,
  DEADLINE_HEADER,
  remainingBeforeDeadline,
  type PerishableResponse,
} from '@arthome-platform/http-edge';
import { Controller, Get, Header, Headers, Inject, Param } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import type { Clock } from '@arthome/core';
import { DateIdSchema } from '@arthome/core/schema';

import type { DateAvailability } from './date-availability.js';
import { GetDateAvailability } from './get-date-availability.query.js';
import { CLOCK } from '../clock.js';

/**
 * The storefront's public read, behind its BFF, which sets the cache headers: `public, max-age=15`
 *   for an anonymous caller (the operation's `x-arthome-freshness`, transport.md §5.9).
 */
@AllowInProduction()
@Controller('v1')
export class AvailabilityController {
  public constructor(
    private readonly queries: QueryBus,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('dates/:dateId/availability')
  @Header('cache-control', 'no-store')
  public availability(
    @Param('dateId', { schema: DateIdSchema }) dateId: string,
    @Headers(DEADLINE_HEADER) deadline: string | undefined,
  ): Promise<PerishableResponse<DateAvailability>> {
    remainingBeforeDeadline(deadline, this.clock);
    return this.queries.execute(new GetDateAvailability(dateId));
  }
}
