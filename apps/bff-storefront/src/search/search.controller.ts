import type { ServerResponse } from 'node:http';

import {
  AllowInProduction,
  CollectionResponse,
  Endpoint,
  EndpointHeaders,
  EndpointQuery,
  whenCallerLeaves,
} from '@arthome-platform/http-edge';
import { Controller, Header, Headers, Inject, Res } from '@nestjs/common';

import type { RouteHeaders } from '@arthome/contracts/http';
import { storefrontApi } from '@arthome/contracts/storefront-api';
import type { Clock } from '@arthome/core';

import type { SearchQuery } from './search-query.schema.js';
import { SearchResponseSchema, type SearchResponse } from './search-response.schema.js';
import { CatalogClient } from '../catalog/catalog.client.js';
import { CLOCK } from '../clock.js';
import { searchParamsOf } from '../query-string.js';
import { VARY_AUTH } from '../storefront-surface.js';

/** transport.md §5.9 and the operation's own description: a television types one key at a time. */
const SEARCH_BUDGET_MS = 200;

type Fields = Pick<SearchResponse, 'groups' | 'facets' | 'page'>;

const { search } = storefrontApi.routes;

@AllowInProduction()
@Controller()
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
  @Endpoint(search)
  @Header('cache-control', 'public, max-age=60')
  @Header('vary', VARY_AUTH)
  public async search(
    @EndpointQuery(search) query: SearchQuery,
    // Validated for the refusal alone: a caller that is not a storefront surface is answered 400.
    @EndpointHeaders(search) _headers: RouteHeaders<typeof search>,
    @Headers('traceparent') traceparent: string,
    @Res({ passthrough: true }) reply: { readonly raw: ServerResponse },
  ): Promise<CollectionResponse<Fields>> {
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
