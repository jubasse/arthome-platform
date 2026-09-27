import { Injectable } from '@nestjs/common';
import { EventPublisher, type IAggregateRoot } from '@nestjs/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import type { PerformanceDateRepository } from './dates/performance-date.repository.js';
import { TypeOrmPerformanceDateRepository } from './dates/performance-date.typeorm-repository.js';
import type { PublicationRepository } from './dates/publication.repository.js';
import { TypeOrmPublicationRepository } from './dates/publication.typeorm-repository.js';

/** One transaction: its repositories, and its manager for the rest of what the command writes. */
export class CatalogTransaction {
  public readonly dates: PerformanceDateRepository;
  public readonly publications: PublicationRepository;

  public constructor(
    public readonly manager: EntityManager,
    saved: (aggregate: IAggregateRoot) => void,
  ) {
    this.dates = new TypeOrmPerformanceDateRepository(manager, saved);
    this.publications = new TypeOrmPublicationRepository(manager, saved);
  }
}

/**
 * Opens the transaction a command runs in, and publishes the domain events of the aggregates saved
 *   in it once it has committed, never inside it: a rollback cannot recall a published event
 *   (context-map §12). Merged here rather than at load, so no handler can forget it: an unmerged
 *   aggregate's `commit()` drops its events without a word.
 */
@Injectable()
export class CatalogTransactions {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly publisher: EventPublisher,
  ) {}

  public async run<T>(work: (transaction: CatalogTransaction) => Promise<T>): Promise<T> {
    const saved = new Set<IAggregateRoot>();
    const result = await this.dataSource.transaction((manager) =>
      work(new CatalogTransaction(manager, (aggregate) => saved.add(aggregate))),
    );
    for (const aggregate of saved) this.publisher.mergeObjectContext(aggregate).commit();
    return result;
  }
}
