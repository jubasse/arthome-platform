import { parseTraceparent, type MemorisedResponse } from '@arthome-platform/http-edge';
import { Body, Controller, Get, Header, HttpCode, Headers, Param, Post } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';

import { DateIdSchema } from '@arthome/core/schema';

import type { DateSheet, PublicationView } from './date-sheet.js';
import { DatesService } from './dates.service.js';
import { DeclareOutcome, type DeclaredOutcome } from './declare-outcome.command.js';
import { DeclareOutcomeSchema, type DeclareOutcomeBody } from './declare-outcome.schema.js';
import { DraftDateSchema, type DraftDateBody } from './draft-date.schema.js';
import { GetDateSheet } from './get-date-sheet.query.js';
import {
  TransitionPublicationSchema,
  type TransitionPublicationBody,
} from './transition-publication.schema.js';
import { ChannelIdParam } from '../channel-id.schema.js';
import { fingerprintOf, idempotencyKeyOf } from '../idempotency/idempotency.js';

@Controller()
export class DatesController {
  public constructor(
    private readonly dates: DatesService,
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
  ) {}

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

  @Post('v1/dates/:dateId/outcome')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public declareOutcome(
    @Param('dateId', { schema: DateIdSchema }) dateId: string,
    @Body({ schema: DeclareOutcomeSchema }) body: DeclareOutcomeBody,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('traceparent') traceparent?: string,
  ): Promise<MemorisedResponse<DeclaredOutcome>> {
    const trace = parseTraceparent(traceparent);
    return this.commands.execute(
      new DeclareOutcome(dateId, body, trace === null ? null : trace.traceparent, {
        key: idempotencyKeyOf(idempotencyKey),
        accountId: null,
        fingerprint: fingerprintOf('POST', `/v1/dates/${dateId}/outcome`, body),
        statusCode: 200,
      }),
    );
  }

  @Get('dates/:dateId')
  @Header('cache-control', 'no-store')
  public sheet(@Param('dateId', { schema: DateIdSchema }) dateId: string): Promise<DateSheet> {
    return this.queries.execute(new GetDateSheet(dateId));
  }
}
