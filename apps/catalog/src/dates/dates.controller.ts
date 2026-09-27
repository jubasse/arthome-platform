import {
  idempotentRequestOf,
  parseTraceparent,
  type MemorisedResponse,
} from '@arthome-platform/http-edge';
import { Body, Controller, Get, Header, HttpCode, Headers, Param, Post } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';

import { DateIdSchema } from '@arthome/core/schema';

import type { DateSheet, PublicationView } from './date-sheet.js';
import { DeclareOutcome, type DeclaredOutcome } from './declare-outcome.command.js';
import { DeclareOutcomeSchema, type DeclareOutcomeBody } from './declare-outcome.schema.js';
import { DraftDate } from './draft-date.command.js';
import { DraftDateSchema, type DraftDateBody } from './draft-date.schema.js';
import { GetDateSheet } from './get-date-sheet.query.js';
import { TransitionPublication } from './transition-publication.command.js';
import {
  TransitionPublicationSchema,
  type TransitionPublicationBody,
} from './transition-publication.schema.js';
import { ChannelIdParam } from '../channel-id.schema.js';

@Controller()
export class DatesController {
  public constructor(
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
    return this.commands.execute(
      new DraftDate(
        channelId,
        body,
        trace === null ? null : trace.traceparent,
        idempotentRequestOf('POST', `/channels/${channelId}/dates`, body, 201, idempotencyKey),
      ),
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
    return this.commands.execute(
      new TransitionPublication(
        dateId,
        body,
        trace === null ? null : trace.traceparent,
        idempotentRequestOf(
          'POST',
          `/dates/${dateId}/publication/transitions`,
          body,
          200,
          idempotencyKey,
        ),
      ),
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
      new DeclareOutcome(
        dateId,
        body,
        trace === null ? null : trace.traceparent,
        idempotentRequestOf('POST', `/v1/dates/${dateId}/outcome`, body, 200, idempotencyKey),
      ),
    );
  }

  @Get('dates/:dateId')
  @Header('cache-control', 'no-store')
  public sheet(@Param('dateId', { schema: DateIdSchema }) dateId: string): Promise<DateSheet> {
    return this.queries.execute(new GetDateSheet(dateId));
  }
}
