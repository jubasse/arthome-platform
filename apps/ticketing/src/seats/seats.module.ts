import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { CancelSeatHandler } from './cancel-seat.handler.js';
import { RefundSeatHandler } from './refund-seat.handler.js';
import { SeatRefundsController } from './seat-refunds.controller.js';
import { SeatsController } from './seats.controller.js';
import { CLOCK } from '../clock.js';
import { TicketingTransactionsModule } from '../ticketing-transactions.js';

/** A seat's end before its date: the viewer's cancellation and the studio's refund, in the API process. */
@Module({
  imports: [TicketingTransactionsModule],
  controllers: [SeatsController, SeatRefundsController],
  providers: [
    CancelSeatHandler,
    RefundSeatHandler,
    { provide: CLOCK, useValue: new SystemClock() },
  ],
})
export class SeatsModule {}
