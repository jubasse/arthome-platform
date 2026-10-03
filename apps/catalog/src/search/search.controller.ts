import type { ServerResponse } from 'node:http';

import {
  AllowInProduction,
  DEADLINE_HEADER,
  Endpoint,
  remainingBeforeDeadline,
  whenCallerLeaves,
  type CollectionResponse,
} from '@arthome-platform/http-edge';
import { Controller, Header, Headers, Inject, Query, Res } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';

import { storefrontApi } from '@arthome/contracts/storefront-api';
import type { Clock } from '@arthome/core';

import { SearchCatalog } from './search-catalog.query.js';
import type { SearchPage } from './search-page.js';
import { SearchQuerySchema, type SearchQuery } from './search-query.schema.js';
import { CLOCK } from '../clock.js';

const { search } = storefrontApi.routes;

/** Behind the storefront BFF, which sets the public cache headers; nothing here is cached. */
@AllowInProduction()
@Controller()
export class SearchController {
  public constructor(
    private readonly queries: QueryBus,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Endpoint(search)
  @Header('cache-control', 'no-store')
  public search(
    @Query({ schema: SearchQuerySchema }) query: SearchQuery,
    @Headers(DEADLINE_HEADER) deadline: string | undefined,
    @Res({ passthrough: true }) reply: { readonly raw: ServerResponse },
  ): Promise<CollectionResponse<SearchPage>> {
    const remainingMs = remainingBeforeDeadline(deadline, this.clock);
    return this.queries.execute(new SearchCatalog(query, remainingMs, whenCallerLeaves(reply.raw)));
  }
}
