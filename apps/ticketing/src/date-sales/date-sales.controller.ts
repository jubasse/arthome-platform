import {
  CurrentPrincipal,
  idempotentRequestOf,
  parseTraceparent,
  type MemorisedResponse,
  type Principal,
} from '@arthome-platform/http-edge';
import { Body, Controller, Get, Header, HttpCode, Headers, Param, Post, Put } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';

import { DateIdSchema } from '@arthome/core/schema';

import type { DateSalesPane } from './date-sales-pane.js';
import { GetDateTicketsPane } from './get-date-tickets-pane.query.js';
import { OpenCapacityTier, type OpenedCapacityTier } from './open-capacity-tier.command.js';
import { OpenCapacityTierSchema, type OpenCapacityTierBody } from './open-capacity-tier.schema.js';
import { SetDatePrices } from './set-date-prices.command.js';
import { SetDatePricesSchema, type SetDatePricesBody } from './set-date-prices.schema.js';
import { SetTechnicalProvision } from './set-technical-provision.command.js';
import {
  SetTechnicalProvisionSchema,
  type SetTechnicalProvisionBody,
} from './set-technical-provision.schema.js';

/** The studio's ticketing operations on one date (openapi/studio.yaml, tag `ticketing`). */
@Controller('v1/dates/:dateId')
export class DateSalesController {
  public constructor(
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
  ) {}

  @Put('prices')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public setPrices(
    @Param('dateId', { schema: DateIdSchema }) dateId: string,
    @Body({ schema: SetDatePricesSchema }) body: SetDatePricesBody,
    @CurrentPrincipal() principal: Principal,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('traceparent') traceparent?: string,
  ): Promise<MemorisedResponse<DateSalesPane>> {
    return this.commands.execute(
      new SetDatePrices(
        dateId,
        body,
        parseTraceparent(traceparent)?.traceparent ?? null,
        idempotentRequestOf(
          'PUT',
          `/v1/dates/${dateId}/prices`,
          body,
          200,
          idempotencyKey,
          principal.accountId,
        ),
      ),
    );
  }

  @Put('technical-provision')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public setTechnicalProvision(
    @Param('dateId', { schema: DateIdSchema }) dateId: string,
    @Body({ schema: SetTechnicalProvisionSchema }) body: SetTechnicalProvisionBody,
    @CurrentPrincipal() principal: Principal,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('traceparent') traceparent?: string,
  ): Promise<MemorisedResponse<DateSalesPane>> {
    return this.commands.execute(
      new SetTechnicalProvision(
        dateId,
        body,
        parseTraceparent(traceparent)?.traceparent ?? null,
        idempotentRequestOf(
          'PUT',
          `/v1/dates/${dateId}/technical-provision`,
          body,
          200,
          idempotencyKey,
          principal.accountId,
        ),
      ),
    );
  }

  @Post('capacity-tiers')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public openCapacityTier(
    @Param('dateId', { schema: DateIdSchema }) dateId: string,
    @Body({ schema: OpenCapacityTierSchema }) body: OpenCapacityTierBody,
    @CurrentPrincipal() principal: Principal,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('traceparent') traceparent?: string,
  ): Promise<MemorisedResponse<OpenedCapacityTier>> {
    return this.commands.execute(
      new OpenCapacityTier(
        dateId,
        body,
        parseTraceparent(traceparent)?.traceparent ?? null,
        idempotentRequestOf(
          'POST',
          `/v1/dates/${dateId}/capacity-tiers`,
          body,
          200,
          idempotencyKey,
          principal.accountId,
        ),
      ),
    );
  }

  @Get('panes/tickets')
  @Header('cache-control', 'no-store')
  public ticketsPane(
    @Param('dateId', { schema: DateIdSchema }) dateId: string,
  ): Promise<DateSalesPane> {
    return this.queries.execute(new GetDateTicketsPane(dateId));
  }
}
