import type { ServerResponse } from 'node:http';

import {
  AllowInProduction,
  Endpoint,
  EndpointHeaders,
  EndpointQuery,
  successSchemaOf,
  whenCallerLeaves,
} from '@arthome-platform/http-edge';
import { Controller, Header, Headers, Inject, Res } from '@nestjs/common';

import type { HandlerOutput, RouteHeaders, RouteQuery } from '@arthome/contracts/http';
import { storefrontApi } from '@arthome/contracts/storefront-api';
import type { Clock } from '@arthome/core';

import { CatalogClient } from '../catalog/catalog.client.js';
import { CLOCK } from '../clock.js';
import { searchParamsOf } from '../query-string.js';
import { VARY_AUTH } from '../storefront-surface.js';

/** transport.md §5.9 and the operation's own description: a television types one key at a time. */
const SEARCH_BUDGET_MS = 200;

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
    @EndpointQuery(search) query: RouteQuery<typeof search>,
    // Validated for the refusal alone: a caller that is not a storefront surface is answered 400.
    @EndpointHeaders(search) _headers: RouteHeaders<typeof search>,
    @Headers('traceparent') traceparent: string,
    @Res({ passthrough: true }) reply: { readonly raw: ServerResponse },
  ): Promise<HandlerOutput<typeof search>> {
    const { groups, facets, page, validUntil } = await this.catalog.get(
      '/v1/search',
      searchParamsOf(query),
      {
        deadline: new Date(this.clock.nowMs() + SEARCH_BUDGET_MS),
        traceparent,
        callerLeft: whenCallerLeaves(reply.raw),
        route: search,
      },
      successSchemaOf(search),
    );
    return {
      ...(groups !== undefined && { groups }),
      facets,
      page,
      ...(validUntil !== undefined && { validUntil }),
    };
  }
}
