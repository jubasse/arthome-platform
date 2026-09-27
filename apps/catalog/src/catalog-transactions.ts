import { Injectable, Module } from '@nestjs/common';
import { EventPublisher } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import type { PerformanceDateRepository } from './dates/performance-date.repository.js';
import { TypeOrmPerformanceDateRepository } from './dates/performance-date.typeorm-repository.js';
import { TransactionRunner, type Track, type Transaction } from './transaction-runner.js';

export interface CatalogRepositories {
  readonly dates: PerformanceDateRepository;
}

export type CatalogTransaction = Transaction<CatalogRepositories>;

function catalogRepositoriesOf(manager: EntityManager, track: Track): CatalogRepositories {
  return { dates: new TypeOrmPerformanceDateRepository(manager, track) };
}

@Injectable()
export class CatalogTransactions extends TransactionRunner<CatalogRepositories> {
  public constructor(@InjectDataSource() dataSource: DataSource, publisher: EventPublisher) {
    super(dataSource, publisher, catalogRepositoriesOf);
  }
}

/** Listed once, here: a second listing in another module's `providers` is a second instance. */
@Module({ providers: [CatalogTransactions], exports: [CatalogTransactions] })
export class CatalogTransactionsModule {}
