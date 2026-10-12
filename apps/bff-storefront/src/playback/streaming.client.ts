import { successSchemaOf } from '@arthome-platform/http-edge';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { ViewerCountryParameter, type HandlerInput } from '@arthome/contracts/http';
import type { PlaybackRenewalSchema, PlaybackTicketSchema } from '@arthome/contracts/streaming';
import { streamingServiceApi } from '@arthome/contracts/streaming-service-api';
import { Service } from '@arthome/core';

import { InternalTokenMinter } from '../internal-token.minter.js';
import { ServiceClient, type ServiceCall } from '../upstream/service-client.js';

export const STREAMING_URL: unique symbol = Symbol('StreamingUrl');

const { openPlayback, renewPlaybackTicket } = streamingServiceApi.routes;

export type OpenPlaybackBody = HandlerInput<typeof openPlayback>['body'];
type PlaybackTicket = z.output<typeof PlaybackTicketSchema>;
type PlaybackRenewal = z.output<typeof PlaybackRenewalSchema>;

const SURFACE_HEADER = 'x-arthome-surface';

/** Streaming's answer, and the `Set-Cookie` lines it signed the ticket with, still to be relayed. */
export interface Signed<T> {
  readonly data: T;
  readonly setCookies: readonly string[];
}

/**
 * The adapter to streaming's player routes (C3): who watches rides in the call's internal token,
 *   the surface and the country in their headers. Release answers no content.
 */
@Injectable()
export class StreamingClient {
  private readonly client: ServiceClient;

  public constructor(@Inject(STREAMING_URL) baseUrl: string, minter: InternalTokenMinter) {
    this.client = new ServiceClient(Service.STREAMING, baseUrl, minter);
  }

  public async open(
    dateId: string,
    body: OpenPlaybackBody,
    surface: string,
    viewerCountry: string,
    call: ServiceCall,
  ): Promise<Signed<PlaybackTicket>> {
    const answer = await this.client.request(
      {
        method: 'POST',
        path: `/v1/playback/${dateId}/open`,
        body,
        headers: {
          [SURFACE_HEADER]: surface,
          [ViewerCountryParameter.name]: viewerCountry,
        },
      },
      call,
      successSchemaOf(openPlayback),
    );
    return { data: answer.body.data, setCookies: answer.setCookies };
  }

  public async renew(
    sessionId: string,
    viewerCountry: string,
    call: ServiceCall,
  ): Promise<Signed<PlaybackRenewal>> {
    const answer = await this.client.request(
      {
        method: 'POST',
        path: `/v1/playback/sessions/${sessionId}/renew`,
        headers: { [ViewerCountryParameter.name]: viewerCountry },
      },
      call,
      successSchemaOf(renewPlaybackTicket),
    );
    return { data: answer.body.data, setCookies: answer.setCookies };
  }

  public async release(sessionId: string, call: ServiceCall): Promise<void> {
    await this.client.request(
      { method: 'POST', path: `/v1/playback/sessions/${sessionId}/release` },
      call,
      z.undefined(),
    );
  }
}
