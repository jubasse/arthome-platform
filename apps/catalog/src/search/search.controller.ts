import type { ServerResponse } from 'node:http';

import {
  DEADLINE_HEADER,
  remainingBeforeDeadline,
  whenCallerLeaves,
  type CollectionResponse,
} from '@arthome-platform/http-edge';
import { Controller, Get, Header, Headers, Inject, Query, Res } from '@nestjs/common';

import type { Clock } from '@arthome/core';

import type { SearchPage } from './search-page.js';
import { SearchQuerySchema, type SearchQuery } from './search-query.schema.js';
import { SearchService } from './search.service.js';
import { CLOCK } from '../clock.js';

/** Behind the storefront BFF, which sets the public cache headers; nothing here is cached. */
@Controller('v1/search')
export class SearchController {
  public constructor(
    private readonly searches: SearchService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get()
  @Header('cache-control', 'no-store')
  public search(
    @Query({ schema: SearchQuerySchema }) query: SearchQuery,
    @Headers(DEADLINE_HEADER) deadline: string | undefined,
    @Res({ passthrough: true }) reply: { readonly raw: ServerResponse },
  ): Promise<CollectionResponse<SearchPage>> {
    const remainingMs = remainingBeforeDeadline(deadline, this.clock);
    return this.searches.search(query, remainingMs, whenCallerLeaves(reply.raw));
  }
}
