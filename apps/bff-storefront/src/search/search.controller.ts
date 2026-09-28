import type { ServerResponse } from 'node:http';

import { CollectionResponse, whenCallerLeaves } from '@arthome-platform/http-edge';
import { Controller, Get, Header, Headers, Inject, Query, Res } from '@nestjs/common';

import type { Clock } from '@arthome/core';

import { SearchQuerySchema, type SearchQuery } from './search-query.schema.js';
import { SearchResponseSchema, type SearchResponse } from './search-response.schema.js';
import { CATALOG_BUDGETS, type CatalogBudgets } from '../catalog/catalog-budgets.js';
import { CatalogClient } from '../catalog/catalog.client.js';
import { CLOCK } from '../clock.js';
import { searchParamsOf } from '../query-string.js';
import { SURFACE_HEADER, VARY_AUTH, assertStorefrontSurface } from '../storefront-surface.js';

type Fields = Pick<SearchResponse, 'groups' | 'facets' | 'page'>;

@Controller('v1/search')
export class SearchController {
  public constructor(
    private readonly catalog: CatalogClient,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CATALOG_BUDGETS) private readonly budgets: CatalogBudgets,
  ) {}

  /**
   * Public, and anonymous in every call today: no overlay is composed, so the body is the same
   *   for every caller and `public` is honest. The day a session adds overlays, this header
   *   must turn `private` for that caller.
   */
  @Get()
  @Header('cache-control', 'public, max-age=60')
  @Header('vary', VARY_AUTH)
  public async search(
    @Query({ schema: SearchQuerySchema }) query: SearchQuery,
    @Headers(SURFACE_HEADER) surface: string | undefined,
    @Headers('traceparent') traceparent: string,
    @Res({ passthrough: true }) reply: { readonly raw: ServerResponse },
  ): Promise<CollectionResponse<Fields>> {
    assertStorefrontSurface(surface);
    const { groups, facets, page, validUntil } = await this.catalog.get(
      '/v1/search',
      searchParamsOf(query),
      {
        deadline: new Date(this.clock.nowMs() + this.budgets.searchMs),
        traceparent,
        callerLeft: whenCallerLeaves(reply.raw),
      },
      SearchResponseSchema,
    );
    return new CollectionResponse(
      { ...(groups !== undefined && { groups }), facets, page },
      validUntil ?? null,
    );
  }
}
