import {
  DEADLINE_HEADER,
  idempotentRequestOf,
  parseTraceparent,
  remainingBeforeDeadline,
  type MemorisedResponse,
  type PerishableResponse,
} from '@arthome-platform/http-edge';
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';

import type { Clock } from '@arthome/core';
import { DateIdSchema, OrderIdSchema } from '@arthome/core/schema';

import { GetOrder } from './get-order.query.js';
import type { OrderDetail, PaymentHandoffView, PurchasedSeats } from './order-views.js';
import { PurchaseSeat, PurchaseStatus } from './purchase-seat.command.js';
import { PurchaseSeatSchema, type PurchaseSeatBody } from './purchase-seat.schema.js';
import { QuoteSeat } from './quote-seat.query.js';
import { QuoteSeatSchema, type QuoteSeatBody } from './quote-seat.schema.js';
import type { SeatQuoteView } from './seat-quote-view.js';
import { CLOCK } from '../clock.js';

const PURCHASE_PATH = '/v1/orders/seats';

interface StatusWriter {
  status(statusCode: number): unknown;
}

/** The storefront's commerce operations on seats (openapi/storefront.yaml, tag `commerce`). */
@Controller('v1')
export class OrdersController {
  public constructor(
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post('dates/:dateId/seat-quote')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public quote(
    @Param('dateId', { schema: DateIdSchema }) dateId: string,
    @Body({ schema: QuoteSeatSchema }) body: QuoteSeatBody,
    @Headers(DEADLINE_HEADER) deadline: string | undefined,
  ): Promise<PerishableResponse<SeatQuoteView>> {
    remainingBeforeDeadline(deadline, this.clock);
    return this.queries.execute(new QuoteSeat(dateId, body));
  }

  /**
   * 201 or 202, which the route cannot declare: `passthrough` keeps the envelope and the replay
   *   header of the interceptor while the status is the command's.
   */
  @Post('orders/seats')
  @Header('cache-control', 'no-store')
  public async purchase(
    @Body({ schema: PurchaseSeatSchema }) body: PurchaseSeatBody,
    @Res({ passthrough: true }) reply: StatusWriter,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('traceparent') traceparent?: string,
  ): Promise<MemorisedResponse<PurchasedSeats | PaymentHandoffView>> {
    const { status, response } = await this.commands.execute(
      new PurchaseSeat(
        body,
        parseTraceparent(traceparent)?.traceparent ?? null,
        idempotentRequestOf('POST', PURCHASE_PATH, body, PurchaseStatus.PAID, idempotencyKey),
      ),
    );
    reply.status(status);
    return response;
  }

  @Get('orders/:orderId')
  @Header('cache-control', 'no-store')
  public order(
    @Param('orderId', { schema: OrderIdSchema }) orderId: string,
    @Headers(DEADLINE_HEADER) deadline: string | undefined,
  ): Promise<OrderDetail> {
    remainingBeforeDeadline(deadline, this.clock);
    return this.queries.execute(new GetOrder(orderId));
  }
}
