import type { ServerResponse } from 'node:http';

import {
  AllowInProduction,
  Endpoint,
  EndpointInput,
  successSchemaOf,
  whenCallerLeaves,
} from '@arthome-platform/http-edge';
import { Controller, Headers, Inject, Res } from '@nestjs/common';

import type { HandlerInput, HandlerOutput, Route } from '@arthome/contracts/http';
import { storefrontApi } from '@arthome/contracts/storefront-api';
import type { Clock } from '@arthome/core';

import { CatalogClient, type CatalogCall } from '../catalog/catalog.client.js';
import { CLOCK } from '../clock.js';
import { entityTagOf } from '../conditional-get.js';
import { searchParamsOf } from '../query-string.js';

/** transport.md §5.9's composed public read. */
const PUBLIC_READ_BUDGET_MS = 400;

const { getDateDetail, getArtistDetail, resolvePublicLink } = storefrontApi.routes;

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
  public async detail(
    @EndpointInput(getDateDetail) { params: { dateId } }: HandlerInput<typeof getDateDetail>,
    @Headers('traceparent') traceparent: string,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<HandlerOutput<typeof getDateDetail>> {
    const { data, validUntil } = await this.catalog.get(
      `/v1/dates/${dateId}`,
      new URLSearchParams(),
      this.callFor(traceparent, reply, getDateDetail),
      successSchemaOf(getDateDetail),
    );
    reply.header('etag', entityTagOf({ data, validUntil }));
    return { data, ...(validUntil !== undefined && { validUntil }) };
  }

  @Endpoint(getArtistDetail)
  public async artist(
    @EndpointInput(getArtistDetail) { params: { artistId } }: HandlerInput<typeof getArtistDetail>,
    @Headers('traceparent') traceparent: string,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<HandlerOutput<typeof getArtistDetail>> {
    const { data, validUntil } = await this.catalog.get(
      `/v1/artists/${artistId}`,
      new URLSearchParams(),
      this.callFor(traceparent, reply, getArtistDetail),
      successSchemaOf(getArtistDetail),
    );
    return { data, ...(validUntil !== undefined && { validUntil }) };
  }

  @Endpoint(resolvePublicLink)
  public async resolve(
    @EndpointInput(resolvePublicLink) { query }: HandlerInput<typeof resolvePublicLink>,
    @Headers('traceparent') traceparent: string,
    @Res({ passthrough: true }) reply: Reply,
  ): Promise<HandlerOutput<typeof resolvePublicLink>> {
    const { data, validUntil } = await this.catalog.get(
      '/v1/resolve',
      searchParamsOf(query),
      this.callFor(traceparent, reply, resolvePublicLink),
      successSchemaOf(resolvePublicLink),
    );
    return { data, ...(validUntil !== undefined && { validUntil }) };
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
