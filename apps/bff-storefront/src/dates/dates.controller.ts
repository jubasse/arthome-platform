import type { ServerResponse } from 'node:http';

import {
  AllowInProduction,
  Endpoint,
  EndpointHeaders,
  EndpointParams,
  EndpointQuery,
  PerishableResponse,
  successSchemaOf,
  whenCallerLeaves,
} from '@arthome-platform/http-edge';
import { Controller, Header, Headers, Inject, Res } from '@nestjs/common';

import type {
  Route,
  RouteHeaders,
  RouteParams,
  RouteQuery,
  RouteResponseBody,
} from '@arthome/contracts/http';
import { storefrontApi } from '@arthome/contracts/storefront-api';
import type { Clock } from '@arthome/core';

import { CatalogClient, type CatalogCall } from '../catalog/catalog.client.js';
import { CLOCK } from '../clock.js';
import { entityTagOf } from '../conditional-get.js';
import { searchParamsOf } from '../query-string.js';
import { VARY_AUTH } from '../storefront-surface.js';

/** transport.md §5.9's composed public read. */
const PUBLIC_READ_BUDGET_MS = 400;

const { getDateDetail, getArtistDetail, resolvePublicLink } = storefrontApi.routes;

type DateDetail = RouteResponseBody<typeof getDateDetail, 200>['data'];
type ArtistDetail = RouteResponseBody<typeof getArtistDetail, 200>['data'];
type ResolvedLink = RouteResponseBody<typeof resolvePublicLink, 200>['data'];

interface Reply {
  readonly raw: ServerResponse;
  header(name: string, value: string): unknown;
}

/** Public and anonymous, like the search: the body is the same for every caller today. */
@AllowInProduction()
@Controller()
export class DatesController {
  public constructor(
    private readonly catalog: CatalogClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The TV prefetches the focused date: the `ETag` spares it a second payment (the contract). */
  @Endpoint(getDateDetail)
  @Header('cache-control', 'public, max-age=60')
  @Header('vary', VARY_AUTH)
  public async detail(
    @EndpointParams(getDateDetail) { dateId }: RouteParams<typeof getDateDetail>,
    @EndpointHeaders(getDateDetail) _headers: RouteHeaders<typeof getDateDetail>,
    @Headers('traceparent') traceparent: string,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<PerishableResponse<DateDetail>> {
    const { data, validUntil } = await this.catalog.get(
      `/v1/dates/${dateId}`,
      new URLSearchParams(),
      this.callFor(traceparent, reply, getDateDetail),
      successSchemaOf(getDateDetail),
    );
    reply.header('etag', entityTagOf({ data, validUntil }));
    return new PerishableResponse(data, validUntil ?? null);
  }

  @Endpoint(getArtistDetail)
  @Header('cache-control', 'public, max-age=300')
  @Header('vary', VARY_AUTH)
  public async artist(
    @EndpointParams(getArtistDetail) { artistId }: RouteParams<typeof getArtistDetail>,
    @EndpointHeaders(getArtistDetail) _headers: RouteHeaders<typeof getArtistDetail>,
    @Headers('traceparent') traceparent: string,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<PerishableResponse<ArtistDetail>> {
    const { data, validUntil } = await this.catalog.get(
      `/v1/artists/${artistId}`,
      new URLSearchParams(),
      this.callFor(traceparent, reply, getArtistDetail),
      successSchemaOf(getArtistDetail),
    );
    return new PerishableResponse(data, validUntil ?? null);
  }

  @Endpoint(resolvePublicLink)
  @Header('cache-control', 'public, max-age=300')
  @Header('vary', VARY_AUTH)
  public async resolve(
    @EndpointQuery(resolvePublicLink) query: RouteQuery<typeof resolvePublicLink>,
    @EndpointHeaders(resolvePublicLink) _headers: RouteHeaders<typeof resolvePublicLink>,
    @Headers('traceparent') traceparent: string,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<PerishableResponse<ResolvedLink>> {
    const { data, validUntil } = await this.catalog.get(
      '/v1/resolve',
      searchParamsOf(query),
      this.callFor(traceparent, reply, resolvePublicLink),
      successSchemaOf(resolvePublicLink),
    );
    return new PerishableResponse(data, validUntil ?? null);
  }

  private callFor(traceparent: string, reply: Reply, route: Route): CatalogCall {
    return {
      deadline: new Date(this.clock.nowMs() + PUBLIC_READ_BUDGET_MS),
      traceparent,
      callerLeft: whenCallerLeaves(reply.raw),
      route,
    };
  }
}
