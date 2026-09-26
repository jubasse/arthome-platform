import {
  DEADLINE_HEADER,
  remainingBeforeDeadline,
  type PerishableResponse,
} from '@arthome-platform/http-edge';
import { Controller, Get, Header, Headers, Inject, Param, Query } from '@nestjs/common';

import type { Clock } from '@arthome/core';
import { ArtistIdSchema, DateIdSchema } from '@arthome/core/schema';

import type { ArtistDetail } from './artist-page.js';
import type { DateDetail } from './date-detail.js';
import { PublicArtistsService } from './public-artists.service.js';
import { PublicDatesService } from './public-dates.service.js';
import { PublicLinksService, type ResolvedLink } from './public-links.service.js';
import { ResolveQuerySchema, type ResolveQuery } from './resolve-query.schema.js';
import { CLOCK } from '../clock.js';

/** The storefront's public reads, behind its BFF, which sets the cache headers. */
@Controller('v1')
export class PublicDatesController {
  public constructor(
    private readonly dates: PublicDatesService,
    private readonly artists: PublicArtistsService,
    private readonly links: PublicLinksService,
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

  @Get('artists/:artistId')
  @Header('cache-control', 'no-store')
  public artist(
    @Param('artistId', { schema: ArtistIdSchema }) artistId: string,
    @Headers(DEADLINE_HEADER) deadline: string | undefined,
  ): Promise<PerishableResponse<ArtistDetail>> {
    remainingBeforeDeadline(deadline, this.clock);
    return this.artists.page(artistId);
  }

  @Get('resolve')
  @Header('cache-control', 'no-store')
  public resolve(
    @Query({ schema: ResolveQuerySchema }) query: ResolveQuery,
    @Headers(DEADLINE_HEADER) deadline: string | undefined,
  ): Promise<PerishableResponse<ResolvedLink>> {
    remainingBeforeDeadline(deadline, this.clock);
    return this.links.resolve(query);
  }
}
