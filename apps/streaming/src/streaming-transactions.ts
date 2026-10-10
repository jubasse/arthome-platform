import { TransactionRunner, type TransactionScope } from '@arthome-platform/transactions';
import { Injectable, Module } from '@nestjs/common';
import { EventPublisher } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

/** A transaction's repositories, one per aggregate, bound to its manager. */
export type StreamingTransaction = TransactionScope;

function streamingTransactionOf(manager: EntityManager): StreamingTransaction {
  return { manager };
}

@Injectable()
export class StreamingTransactions extends TransactionRunner<StreamingTransaction> {
  public constructor(@InjectDataSource() dataSource: DataSource, publisher: EventPublisher) {
    super(dataSource, publisher, streamingTransactionOf);
  }
}

/** Listed once, here: a second listing in another module's `providers` is a second instance. */
@Module({ providers: [StreamingTransactions], exports: [StreamingTransactions] })
export class StreamingTransactionsModule {}
