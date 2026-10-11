import {
  CurrentPrincipal,
  DEADLINE_HEADER,
  accountOf,
  idempotentRequestOf,
  parseTraceparent,
  remainingBeforeDeadline,
  type MemorisedResponse,
  type Principal,
} from '@arthome-platform/http-edge';
import {
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Put,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';

import type { Clock } from '@arthome/core';
import { DateIdSchema } from '@arthome/core/schema';

import { GetWaitlistRegistration } from './get-waitlist-registration.query.js';
import { JoinWaitlist } from './join-waitlist.command.js';
import { LeaveWaitlist, type WaitlistDepartureView } from './leave-waitlist.command.js';
import type { WaitlistRegistrationView } from './waitlist-registration.js';
import { CLOCK } from '../clock.js';

/**
 * The storefront's waiting list on one date (storefront.yaml, `joinWaitlist`, `leaveWaitlist`,
 *   `getWaitlistRegistration`), for the account the internal token names, never the path. The BFF
 *   adds the `DateCard` (T7). Ticketing's own routes until its internal contract exists (D-121).
 */
@Controller('v1/dates/:dateId/waitlist')
export class WaitlistController {
  public constructor(
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Put()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public join(
    @Param('dateId', { schema: DateIdSchema }) dateId: string,
    @CurrentPrincipal() principal: Principal,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('traceparent') traceparent?: string,
  ): Promise<MemorisedResponse<WaitlistRegistrationView>> {
    const accountId = accountOf(principal);
    return this.commands.execute(
      new JoinWaitlist(
        dateId,
        accountId,
        parseTraceparent(traceparent)?.traceparent ?? null,
        idempotentRequestOf('PUT', pathOf(dateId), {}, 200, idempotencyKey, accountId),
      ),
    );
  }

  @Delete()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  public leave(
    @Param('dateId', { schema: DateIdSchema }) dateId: string,
    @CurrentPrincipal() principal: Principal,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('traceparent') traceparent?: string,
  ): Promise<MemorisedResponse<WaitlistDepartureView>> {
    const accountId = accountOf(principal);
    return this.commands.execute(
      new LeaveWaitlist(
        dateId,
        accountId,
        parseTraceparent(traceparent)?.traceparent ?? null,
        idempotentRequestOf('DELETE', pathOf(dateId), {}, 200, idempotencyKey, accountId),
      ),
    );
  }

  @Get()
  @Header('cache-control', 'no-store')
  public registration(
    @Param('dateId', { schema: DateIdSchema }) dateId: string,
    @Headers(DEADLINE_HEADER) deadline: string | undefined,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WaitlistRegistrationView> {
    const accountId = accountOf(principal);
    remainingBeforeDeadline(deadline, this.clock);
    return this.queries.execute(new GetWaitlistRegistration(dateId, accountId));
  }
}

function pathOf(dateId: string): string {
  return `/v1/dates/${dateId}/waitlist`;
}
