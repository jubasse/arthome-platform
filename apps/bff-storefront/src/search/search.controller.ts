import type { ServerResponse } from 'node:http';

import {
  AllowInProduction,
  Endpoint,
  EndpointInput,
  successSchemaOf,
  whenCallerLeaves,
} from '@arthome-platform/http-edge';
import { Controller, Headers, Inject, Res } from '@nestjs/common';

import type { HandlerInput, HandlerOutput } from '@arthome/contracts/http';
import { storefrontApi } from '@arthome/contracts/storefront-api';
import type { Clock } from '@arthome/core';

import { CatalogClient } from '../catalog/catalog.client.js';
import { CLOCK } from '../clock.js';
import { searchParamsOf } from '../query-string.js';

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

  @Endpoint(search)
  public async search(
    @EndpointInput(search) { query }: HandlerInput<typeof search>,
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
