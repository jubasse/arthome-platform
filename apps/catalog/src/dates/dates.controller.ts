import { parseTraceparent, type MemorisedResponse } from '@arthome-platform/http-edge';
import { Body, Controller, Get, Header, HttpCode, Headers, Param, Post } from '@nestjs/common';
import { z } from 'zod';

import { DateIdSchema } from '@arthome/core/schema';

import type { DateSheet, PublicationView } from './date-sheet.js';
import { DatesService } from './dates.service.js';
import { DraftDateSchema, type DraftDateBody } from './draft-date.schema.js';
import {
  TransitionPublicationSchema,
  type TransitionPublicationBody,
} from './transition-publication.schema.js';
import { fingerprintOf, idempotencyKeyOf } from '../idempotency/idempotency.js';

/** Text like the show's `channel_id`: the fixtures in use are not UUIDs. */
const ChannelIdParam = z.string().min(1);

@Controller()
export class DatesController {
  public constructor(private readonly dates: DatesService) {}

  @Post('channels/:channelId/dates')
  @HttpCode(201)
  @Header('cache-control', 'no-store')
  public draft(
    @Param('channelId', { schema: ChannelIdParam }) channelId: string,
    @Body({ schema: DraftDateSchema }) body: DraftDateBody,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('traceparent') traceparent?: string,
  ): Promise<MemorisedResponse<DateSheet>> {
    const trace = parseTraceparent(traceparent);
    return this.dates.draft(
      { channelId, ...body, traceparent: trace === null ? null : trace.traceparent },
      {
        key: idempotencyKeyOf(idempotencyKey),
        accountId: null,
        fingerprint: fingerprintOf('POST', `/channels/${channelId}/dates`, body),
        statusCode: 201,
      },
    );
  }

  @Post('dates/:dateId/publication/transitions')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public transition(
    @Param('dateId', { schema: DateIdSchema }) dateId: string,
    @Body({ schema: TransitionPublicationSchema }) body: TransitionPublicationBody,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('traceparent') traceparent?: string,
  ): Promise<MemorisedResponse<PublicationView>> {
    const trace = parseTraceparent(traceparent);
    return this.dates.transition(
      {
        dateId,
        to: body.to,
        expectedVersion: body.expectedVersion,
        acknowledgedPromise: body.acknowledgedPromiseCode,
        traceparent: trace === null ? null : trace.traceparent,
      },
      {
        key: idempotencyKeyOf(idempotencyKey),
        accountId: null,
        fingerprint: fingerprintOf('POST', `/dates/${dateId}/publication/transitions`, body),
        statusCode: 200,
      },
    );
  }

  @Get('dates/:dateId')
  @Header('cache-control', 'no-store')
  public sheet(@Param('dateId', { schema: DateIdSchema }) dateId: string): Promise<DateSheet> {
    return this.dates.sheet(dateId);
  }
}
