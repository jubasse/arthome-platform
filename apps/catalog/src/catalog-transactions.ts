import {
  TransactionRunner,
  type Track,
  type TransactionScope,
} from '@arthome-platform/transactions';
import { Injectable, Module } from '@nestjs/common';
import { EventPublisher } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import type { PerformanceDateRepository } from './dates/performance-date.repository.js';
import { TypeOrmPerformanceDateRepository } from './dates/performance-date.typeorm-repository.js';

export interface CatalogTransaction extends TransactionScope {
  readonly dates: PerformanceDateRepository;
}

function catalogTransactionOf(manager: EntityManager, track: Track): CatalogTransaction {
  return { dates: new TypeOrmPerformanceDateRepository(manager, track), manager };
}

@Injectable()
export class CatalogTransactions extends TransactionRunner<CatalogTransaction> {
  public constructor(@InjectDataSource() dataSource: DataSource, publisher: EventPublisher) {
    super(dataSource, publisher, catalogTransactionOf);
  }
}

/** Listed once, here: a second listing in another module's `providers` is a second instance. */
@Module({ providers: [CatalogTransactions], exports: [CatalogTransactions] })
export class CatalogTransactionsModule {}
