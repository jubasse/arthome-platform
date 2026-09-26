import type { ServerResponse } from 'node:http';

import {
  CollectionResponse,
  RefusalException,
  schemaInvalidRefusal,
  whenCallerLeaves,
} from '@arthome-platform/http-edge';
import { Controller, Get, Header, Headers, HttpStatus, Inject, Query, Res } from '@nestjs/common';
import { z } from 'zod';

import { Surface, type Clock } from '@arthome/core';

import { SearchQuerySchema, searchParamsOf, type SearchQuery } from './search-query.schema.js';
import { SearchResponseSchema, type SearchResponse } from './search-response.schema.js';
import { CatalogClient } from '../catalog/catalog.client.js';
import { CLOCK } from '../clock.js';

/** transport.md §5.9 and the operation's own description: a television types one key at a time. */
const SEARCH_BUDGET_MS = 200;

/**
 * The narrowing `storefront.yaml` declares on `X-Arthome-Surface`: a studio surface here is a
 *   caller in the wrong place, refused rather than tolerated.
 */
const StorefrontSurfaceSchema = z.enum([
  Surface.STOREFRONT_WEB,
  Surface.STOREFRONT_MOBILE,
  Surface.STOREFRONT_TV,
]);

type Fields = Pick<SearchResponse, 'groups' | 'facets' | 'page'>;

@Controller('v1/search')
export class SearchController {
  public constructor(
    private readonly catalog: CatalogClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Public, and anonymous in every call today: no overlay is composed, so the body is the same
   *   for every caller and `public` is honest. The day a session adds overlays, this header
   *   must turn `private` for that caller.
   */
  @Get()
  @Header('cache-control', 'public, max-age=60')
  @Header('vary', 'Cookie, Authorization, X-Arthome-Device-Token, X-Arthome-Surface')
  public async search(
    @Query({ schema: SearchQuerySchema }) query: SearchQuery,
    @Headers('x-arthome-surface') surface: string | undefined,
    @Headers('traceparent') traceparent: string,
    @Res({ passthrough: true }) reply: { readonly raw: ServerResponse },
  ): Promise<CollectionResponse<Fields>> {
    if (!StorefrontSurfaceSchema.safeParse(surface).success) {
      throw new RefusalException(
        HttpStatus.BAD_REQUEST,
        schemaInvalidRefusal([{ path: ['x-arthome-surface'] }]),
      );
    }
    const { groups, facets, page, validUntil } = await this.catalog.get(
      '/v1/search',
      searchParamsOf(query),
      {
        deadline: new Date(this.clock.nowMs() + SEARCH_BUDGET_MS),
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
