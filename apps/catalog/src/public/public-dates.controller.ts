import {
  DEADLINE_HEADER,
  remainingBeforeDeadline,
  type PerishableResponse,
} from '@arthome-platform/http-edge';
import { Controller, Get, Header, Headers, Inject, Param, Query } from '@nestjs/common';

import type { Clock } from '@arthome/core';
import { DateIdSchema } from '@arthome/core/schema';

import type { DateDetail } from './date-detail.js';
import { PublicDatesService, type ResolvedLink } from './public-dates.service.js';
import { ResolveQuerySchema, type ResolveQuery } from './resolve-query.schema.js';
import { CLOCK } from '../clock.js';

/** The storefront's reads of a public date, behind its BFF, which sets the cache headers. */
@Controller('v1')
export class PublicDatesController {
  public constructor(
    private readonly dates: PublicDatesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('dates/:dateId')
  @Header('cache-control', 'no-store')
  public detail(
    @Param('dateId', { schema: DateIdSchema }) dateId: string,
    @Headers(DEADLINE_HEADER) deadline: string | undefined,
  ): Promise<PerishableResponse<DateDetail>> {
    remainingBeforeDeadline(deadline, this.clock);
    return this.dates.detail(dateId);
  }

  @Get('resolve')
  @Header('cache-control', 'no-store')
  public resolve(
    @Query({ schema: ResolveQuerySchema }) query: ResolveQuery,
    @Headers(DEADLINE_HEADER) deadline: string | undefined,
  ): Promise<PerishableResponse<ResolvedLink>> {
    remainingBeforeDeadline(deadline, this.clock);
    return this.dates.resolve(query);
  }
}
