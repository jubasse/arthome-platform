import { readPublicWebOrigin } from '@arthome-platform/config';
import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { GetOrderHandler } from './get-order.handler.js';
import { OrdersController } from './orders.controller.js';
import { PurchaseSeatHandler } from './purchase-seat.handler.js';
import { QuoteSeatHandler } from './quote-seat.handler.js';
import { CLOCK } from '../clock.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { PUBLIC_WEB_ORIGIN } from '../public-web-origin.js';
import { TicketingTransactionsModule } from '../ticketing-transactions.js';

/** The storefront's side of a seat: its quote, its purchase and its order, in the API process. */
@Module({
  imports: [TicketingTransactionsModule, PaymentsModule],
  controllers: [OrdersController],
  providers: [
    QuoteSeatHandler,
    PurchaseSeatHandler,
    GetOrderHandler,
    { provide: CLOCK, useValue: new SystemClock() },
    { provide: PUBLIC_WEB_ORIGIN, useValue: readPublicWebOrigin() },
  ],
})
export class OrdersModule {}
