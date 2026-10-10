import {
  TransactionRunner,
  type Track,
  type TransactionScope,
} from '@arthome-platform/transactions';
import { Injectable, Module } from '@nestjs/common';
import { EventPublisher } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import type { CreditRepository } from './credits/credit.repository.js';
import { TypeOrmCreditRepository } from './credits/credit.typeorm-repository.js';
import type { DateSalesRepository } from './date-sales/date-sales.repository.js';
import { TypeOrmDateSalesRepository } from './date-sales/date-sales.typeorm-repository.js';
import type { SeatHoldRepository } from './orders/seat-hold.repository.js';
import { TypeOrmSeatHoldRepository } from './orders/seat-hold.typeorm-repository.js';
import type { SeatOrderRepository } from './orders/seat-order.repository.js';
import { TypeOrmSeatOrderRepository } from './orders/seat-order.typeorm-repository.js';
import type { WaitlistEntryRepository } from './waitlist/waitlist-entry.repository.js';
import { TypeOrmWaitlistEntryRepository } from './waitlist/waitlist-entry.typeorm-repository.js';

export interface TicketingTransaction extends TransactionScope {
  readonly credits: CreditRepository;
  readonly dateSales: DateSalesRepository;
  readonly holds: SeatHoldRepository;
  readonly orders: SeatOrderRepository;
  readonly waitlistEntries: WaitlistEntryRepository;
}

function ticketingTransactionOf(manager: EntityManager, track: Track): TicketingTransaction {
  return {
    credits: new TypeOrmCreditRepository(manager, track),
    dateSales: new TypeOrmDateSalesRepository(manager, track),
    holds: new TypeOrmSeatHoldRepository(manager, track),
    orders: new TypeOrmSeatOrderRepository(manager, track),
    waitlistEntries: new TypeOrmWaitlistEntryRepository(manager, track),
    manager,
  };
}

@Injectable()
export class TicketingTransactions extends TransactionRunner<TicketingTransaction> {
  public constructor(@InjectDataSource() dataSource: DataSource, publisher: EventPublisher) {
    super(dataSource, publisher, ticketingTransactionOf);
  }
}

/** Listed once, here: a second listing in another module's `providers` is a second instance. */
@Module({ providers: [TicketingTransactions], exports: [TicketingTransactions] })
export class TicketingTransactionsModule {}
