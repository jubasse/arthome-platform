import {
  CurrentPrincipal,
  idempotentRequestOf,
  parseTraceparent,
  schemaInvalidException,
  type MemorisedResponse,
  type Principal,
} from '@arthome-platform/http-edge';
import { Body, Controller, Header, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

import { SeatIdSchema } from '@arthome/core/schema';

import { RefundSeat, type SeatRefundView } from './refund-seat.command.js';
import { RefundSeatSchema, type RefundSeatBody } from './refund-seat.schema.js';

/** The studio contract's `IfRightsVersionParameter`. */
const RIGHTS_VERSION_HEADER = 'If-Rights-Version';

/** An integer when present; anything else is a malformed call naming the header. */
function rightsVersionOf(header: string | undefined): number | null {
  if (header === undefined) return null;
  if (!/^\d{1,15}$/.test(header)) {
    throw schemaInvalidException([{ path: [RIGHTS_VERSION_HEADER] }]);
  }
  return Number(header);
}

/**
 * The studio's `refundSeat` (tag `ticketing`). Refused in production until auth slice B, which
 *   checks the operator's rights and `If-Rights-Version` on the loaded seat, as the other studio
 *   routes are.
 */
@Controller('v1/seats/:seatId')
export class SeatRefundsController {
  public constructor(private readonly commands: CommandBus) {}

  @Post('refund')
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public refund(
    @Param('seatId', { schema: SeatIdSchema }) seatId: string,
    @Body({ schema: RefundSeatSchema }) body: RefundSeatBody,
    @CurrentPrincipal() principal: Principal,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('traceparent') traceparent?: string,
    @Headers(RIGHTS_VERSION_HEADER) rightsVersion?: string,
  ): Promise<MemorisedResponse<SeatRefundView>> {
    return this.commands.execute(
      new RefundSeat(
        seatId,
        body,
        rightsVersionOf(rightsVersion),
        parseTraceparent(traceparent)?.traceparent ?? null,
        idempotentRequestOf(
          'POST',
          `/v1/seats/${seatId}/refund`,
          body,
          200,
          idempotencyKey,
          principal.accountId,
        ),
      ),
    );
  }
}
