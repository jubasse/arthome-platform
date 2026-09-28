import type { ServerResponse } from 'node:http';

import { PerishableResponse, whenCallerLeaves } from '@arthome-platform/http-edge';
import { Controller, Get, Header, Headers, Inject, Param, Query, Res } from '@nestjs/common';
import type { z } from 'zod';

import type { Clock } from '@arthome/core';
import { ArtistIdSchema, DateIdSchema } from '@arthome/core/schema';

import {
  ArtistDetailResponseSchema,
  DateDetailResponseSchema,
  ResolveResponseSchema,
} from './date-responses.schema.js';
import { ResolveQuerySchema, type ResolveQuery } from './resolve-query.schema.js';
import { CATALOG_BUDGETS, type CatalogBudgets } from '../catalog/catalog-budgets.js';
import { CatalogClient, type CatalogCall } from '../catalog/catalog.client.js';
import { CLOCK } from '../clock.js';
import { entityTagOf } from '../conditional-get.js';
import { searchParamsOf } from '../query-string.js';
import { SURFACE_HEADER, VARY_AUTH, assertStorefrontSurface } from '../storefront-surface.js';

type DateDetail = z.output<typeof DateDetailResponseSchema>['data'];
type ResolvedLink = z.output<typeof ResolveResponseSchema>['data'];
type ArtistDetail = z.output<typeof ArtistDetailResponseSchema>['data'];

interface Reply {
  readonly raw: ServerResponse;
  header(name: string, value: string): unknown;
}

/** Public and anonymous, like the search: the body is the same for every caller today. */
@Controller('v1')
export class DatesController {
  public constructor(
    private readonly catalog: CatalogClient,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CATALOG_BUDGETS) private readonly budgets: CatalogBudgets,
  ) {}

  /** The TV prefetches the focused date: the `ETag` spares it a second payment (the contract). */
  @Get('dates/:dateId')
  @Header('cache-control', 'public, max-age=60')
  @Header('vary', VARY_AUTH)
  public async detail(
    @Param('dateId', { schema: DateIdSchema }) dateId: string,
    @Headers(SURFACE_HEADER) surface: string | undefined,
    @Headers('traceparent') traceparent: string,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<PerishableResponse<DateDetail>> {
    assertStorefrontSurface(surface);
    const { data, validUntil } = await this.catalog.get(
      `/v1/dates/${dateId}`,
      new URLSearchParams(),
      this.callFor(traceparent, reply),
      DateDetailResponseSchema,
    );
    reply.header('etag', entityTagOf({ data, validUntil }));
    return new PerishableResponse(data, validUntil ?? null);
  }

  @Get('artists/:artistId')
  @Header('cache-control', 'public, max-age=300')
  @Header('vary', VARY_AUTH)
  public async artist(
    @Param('artistId', { schema: ArtistIdSchema }) artistId: string,
    @Headers(SURFACE_HEADER) surface: string | undefined,
    @Headers('traceparent') traceparent: string,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<PerishableResponse<ArtistDetail>> {
    assertStorefrontSurface(surface);
    const { data, validUntil } = await this.catalog.get(
      `/v1/artists/${artistId}`,
      new URLSearchParams(),
      this.callFor(traceparent, reply),
      ArtistDetailResponseSchema,
    );
    return new PerishableResponse(data, validUntil ?? null);
  }

  @Get('resolve')
  @Header('cache-control', 'public, max-age=300')
  @Header('vary', VARY_AUTH)
  public async resolve(
    @Query({ schema: ResolveQuerySchema }) query: ResolveQuery,
    @Headers(SURFACE_HEADER) surface: string | undefined,
    @Headers('traceparent') traceparent: string,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<PerishableResponse<ResolvedLink>> {
    assertStorefrontSurface(surface);
    const { data, validUntil } = await this.catalog.get(
      '/v1/resolve',
      searchParamsOf(query),
      this.callFor(traceparent, reply),
      ResolveResponseSchema,
    );
    return new PerishableResponse(data, validUntil ?? null);
  }

  private callFor(traceparent: string, reply: Reply): CatalogCall {
    return {
      deadline: new Date(this.clock.nowMs() + this.budgets.publicReadMs),
      traceparent,
      callerLeft: whenCallerLeaves(reply.raw),
    };
  }
}
