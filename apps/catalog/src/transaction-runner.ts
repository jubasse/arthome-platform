import { AsyncLocalStorage } from 'node:async_hooks';

import type { EventPublisher, IAggregateRoot } from '@nestjs/cqrs';
import type {
  DataSource,
  EntityManager,
  EntityTarget,
  FindOptionsWhere,
  ObjectLiteral,
  QueryDeepPartialEntity,
} from 'typeorm';

import { DomainError, DomainErrorCode, type MessageParams } from '@arthome/core';

/** Registers an aggregate an adapter wrote, for the commit after the transaction's. */
export type Track = (aggregate: IAggregateRoot) => void;

/** Binds a transaction's repositories to its manager. */
export type RepositoryFactory<R> = (manager: EntityManager, track: Track) => R;

/** A transaction's repositories, and its manager for what the command writes beside them. */
export type Transaction<R> = R & { readonly manager: EntityManager };

const openTransaction = new AsyncLocalStorage<true>();

/**
 * Opens the transaction a command runs in, hands `work` the repositories bound to it, and once it
 *   has committed publishes the domain events of every aggregate they wrote, never inside it: a
 *   rollback cannot recall a published event (context-map §12). Merged here rather than at load, so
 *   no handler can forget it: an unmerged aggregate's `commit()` drops its events without a word.
 *   A command may run two in turn; one opened inside another is refused, since it would commit on
 *   its own connection whatever the outer one then does.
 */
export class TransactionRunner<R> {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly publisher: EventPublisher,
    private readonly repositoriesOf: RepositoryFactory<R>,
  ) {}

  public async run<T>(work: (transaction: Transaction<R>) => Promise<T>): Promise<T> {
    if (openTransaction.getStore() === true) {
      throw new Error('a transaction is already open: TransactionRunner.run does not nest');
    }
    const written = new Set<IAggregateRoot>();
    const result = await openTransaction.run(true, () =>
      this.dataSource.transaction((manager) =>
        work({ ...this.repositoriesOf(manager, (aggregate) => written.add(aggregate)), manager }),
      ),
    );
    for (const aggregate of written) this.publisher.mergeObjectContext(aggregate).commit();
    return result;
  }
}

/**
 * What every aggregate adapter keeps: the version each aggregate was loaded or last written at,
 *   and the registration of each write. A write method that skips `written` publishes nothing and
 *   saves a second time against a stale version.
 */
export class AggregateTracker<A extends IAggregateRoot> {
  private readonly versions = new WeakMap<A, number>();

  public constructor(private readonly track: Track) {}

  public loaded(aggregate: A, version: number): A {
    this.versions.set(aggregate, version);
    return aggregate;
  }

  /** Undefined for an aggregate this transaction created, which its save inserts. */
  public versionOf(aggregate: A): number | undefined {
    return this.versions.get(aggregate);
  }

  public written(aggregate: A, version: number): void {
    this.versions.set(aggregate, version);
    this.track(aggregate);
  }
}

/**
 * The version-conditional UPDATE (`nestjs-typeorm` rule 7). A change committed since the load is
 *   refused with core's `STATE_CONFLICT`, its params read off the row as it stands now.
 */
export async function saveVersioned<E extends ObjectLiteral & { version: number }>(
  manager: EntityManager,
  entity: EntityTarget<E>,
  key: FindOptionsWhere<E>,
  loadedVersion: number,
  columns: QueryDeepPartialEntity<E>,
  conflictParams: (current: E) => MessageParams,
): Promise<void> {
  const loaded: FindOptionsWhere<E> = { ...key, version: loadedVersion };
  const { affected } = await manager.update(entity, loaded, columns);
  if (affected === 1) return;
  const current = await manager.findOneByOrFail(entity, key);
  throw new DomainError({ code: DomainErrorCode.STATE_CONFLICT, params: conflictParams(current) });
}
