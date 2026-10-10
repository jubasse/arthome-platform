import {
  CurrentPrincipal,
  accountOf,
  idempotentRequestOf,
  parseTraceparent,
  type MemorisedResponse,
  type Principal,
} from '@arthome-platform/http-edge';
import { Body, Controller, Header, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

import { SeatIdSchema } from '@arthome/core/schema';

import { CancelSeat, type SeatCancellationView } from './cancel-seat.command.js';
import { CancelSeatSchema, type CancelSeatBody } from './cancel-seat.schema.js';

/**
 * The storefront's `cancelSeat` (tag `commerce`), for the account the internal token names: a seat
 *   is its buyer's alone. Refused in production with the other commerce routes.
 */
@Controller('v1/seats/:seatId')
export class SeatsController {
  public constructor(private readonly commands: CommandBus) {}

  @Post('cancel')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public cancel(
    @Param('seatId', { schema: SeatIdSchema }) seatId: string,
    @Body({ schema: CancelSeatSchema }) body: CancelSeatBody,
    @CurrentPrincipal() principal: Principal,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('traceparent') traceparent?: string,
  ): Promise<MemorisedResponse<SeatCancellationView>> {
    const accountId = accountOf(principal);
    return this.commands.execute(
      new CancelSeat(
        seatId,
        accountId,
        parseTraceparent(traceparent)?.traceparent ?? null,
        idempotentRequestOf(
          'POST',
          `/v1/seats/${seatId}/cancel`,
          body ?? {},
          200,
          idempotencyKey,
          accountId,
        ),
      ),
    );
  }
}
