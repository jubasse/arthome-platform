import {
  AllowInProduction,
  DEADLINE_HEADER,
  Endpoint,
  remainingBeforeDeadline,
  type PerishableResponse,
} from '@arthome-platform/http-edge';
import { Controller, Header, Headers, Inject, Param, Query } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { storefrontApi } from '@arthome/contracts/storefront-api';
import type { Clock } from '@arthome/core';
import { ArtistIdSchema, DateIdSchema } from '@arthome/core/schema';

import type { ArtistDetail } from './artist-page.js';
import type { DateDetail } from './date-detail.js';
import { GetArtistDetail } from './get-artist-detail.query.js';
import { GetDateDetail } from './get-date-detail.query.js';
import { ResolvePublicLink, type ResolvedLink } from './resolve-public-link.query.js';
import { ResolveQuerySchema, type ResolveQuery } from './resolve-query.schema.js';
import { CLOCK } from '../clock.js';

const { getDateDetail, getArtistDetail, resolvePublicLink } = storefrontApi.routes;

/** The storefront's public reads, behind its BFF, which sets the cache headers. */
@AllowInProduction()
@Controller()
export class PublicDatesController {
  public constructor(
    private readonly queries: QueryBus,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Endpoint(getDateDetail)
  @Header('cache-control', 'no-store')
  public detail(
    @Param('dateId', { schema: DateIdSchema }) dateId: string,
    @Headers(DEADLINE_HEADER) deadline: string | undefined,
  ): Promise<PerishableResponse<DateDetail>> {
    remainingBeforeDeadline(deadline, this.clock);
    return this.queries.execute(new GetDateDetail(dateId));
  }

  @Endpoint(getArtistDetail)
  @Header('cache-control', 'no-store')
  public artist(
    @Param('artistId', { schema: ArtistIdSchema }) artistId: string,
    @Headers(DEADLINE_HEADER) deadline: string | undefined,
  ): Promise<PerishableResponse<ArtistDetail>> {
    remainingBeforeDeadline(deadline, this.clock);
    return this.queries.execute(new GetArtistDetail(artistId));
  }

  @Endpoint(resolvePublicLink)
  @Header('cache-control', 'no-store')
  public resolve(
    @Query({ schema: ResolveQuerySchema }) query: ResolveQuery,
    @Headers(DEADLINE_HEADER) deadline: string | undefined,
  ): Promise<PerishableResponse<ResolvedLink>> {
    remainingBeforeDeadline(deadline, this.clock);
    return this.queries.execute(new ResolvePublicLink(query));
  }
}
