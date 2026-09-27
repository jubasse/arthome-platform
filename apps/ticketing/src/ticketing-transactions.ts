import {
  TransactionRunner,
  type Track,
  type TransactionScope,
} from '@arthome-platform/transactions';
import { Injectable, Module } from '@nestjs/common';
import { EventPublisher } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import type { DateSalesRepository } from './date-sales/date-sales.repository.js';
import { TypeOrmDateSalesRepository } from './date-sales/date-sales.typeorm-repository.js';

export interface TicketingTransaction extends TransactionScope {
  readonly dateSales: DateSalesRepository;
}

function ticketingTransactionOf(manager: EntityManager, track: Track): TicketingTransaction {
  return { dateSales: new TypeOrmDateSalesRepository(manager, track), manager };
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
