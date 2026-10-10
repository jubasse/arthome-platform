import {
  TransactionRunner,
  type Track,
  type TransactionScope,
} from '@arthome-platform/transactions';
import { Injectable, Module } from '@nestjs/common';
import { EventPublisher } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import type { RunRepository } from './run/run.repository.js';
import { TypeOrmRunRepository } from './run/run.typeorm-repository.js';

/** A transaction's repositories, one per aggregate, bound to its manager. */
export interface StreamingTransaction extends TransactionScope {
  readonly runs: RunRepository;
}

function streamingTransactionOf(manager: EntityManager, track: Track): StreamingTransaction {
  return { runs: new TypeOrmRunRepository(manager, track), manager };
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
