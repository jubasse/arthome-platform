import { AggregateRoot, EventPublisher, type EventBus, type IEvent } from '@nestjs/cqrs';
import type { DataSource, EntityManager } from 'typeorm';
import { describe, expect, it } from 'vitest';

import { DomainErrorCode, isDomainError } from '@arthome/core';

import {
  AggregateTracker,
  TransactionRunner,
  saveVersioned,
  type Track,
  type TransactionScope,
} from './transaction-runner.js';

class Incremented implements IEvent {
  public constructor(
    readonly counterId: string,
    readonly value: number,
  ) {}
}

class Counter extends AggregateRoot {
  public constructor(
    readonly id: string,
    public value: number,
  ) {
    super();
  }

  public increment(): void {
    this.value += 1;
    this.apply(new Incremented(this.id, this.value));
  }
}

class CounterRow {
  id!: string;
  value!: number;
  version!: number;
}

/** One table of counters, and the UPDATE's `affected` as Postgres would count it. */
class FakeManager {
  public readonly rows = new Map<string, CounterRow>();

  public constructor(rows: readonly CounterRow[] = []) {
    for (const row of rows) this.rows.set(row.id, { ...row });
  }

  public update(
    _entity: unknown,
    where: { id: string; version?: number },
    columns: Partial<CounterRow>,
  ): Promise<{ affected: number }> {
    const row = this.rows.get(where.id);
    if (row === undefined || (where.version !== undefined && row.version !== where.version)) {
      return Promise.resolve({ affected: 0 });
    }
    Object.assign(row, columns);
    return Promise.resolve({ affected: 1 });
  }

  public findOneByOrFail(_entity: unknown, where: { id: string }): Promise<CounterRow> {
    const row = this.rows.get(where.id);
    return row === undefined ? Promise.reject(new Error('no row')) : Promise.resolve({ ...row });
  }
}

class CounterRepository {
  private readonly tracker: AggregateTracker<Counter>;

  public constructor(
    private readonly manager: EntityManager,
    track: Track,
  ) {
    this.tracker = new AggregateTracker(track);
  }

  public async findById(id: string): Promise<Counter> {
    const row = await this.manager.findOneByOrFail(CounterRow, { id });
    return this.tracker.loaded(new Counter(row.id, row.value), row.version);
  }

  public async save(counter: Counter): Promise<void> {
    const loadedVersion = this.tracker.versionOf(counter) ?? 0;
    await saveVersioned(
      this.manager,
      CounterRow,
      { id: counter.id },
      loadedVersion,
      { value: counter.value, version: loadedVersion + 1 },
      ({ version }) => ({ version }),
    );
    this.tracker.written(counter, loadedVersion + 1);
  }

  /** Registered without a version, the way a conditional decrement is. */
  public async bump(counter: Counter): Promise<void> {
    await this.manager.update(CounterRow, { id: counter.id }, { value: counter.value });
    this.tracker.writtenUnversioned(counter);
  }
}

interface CounterTransaction extends TransactionScope {
  readonly counters: CounterRepository;
}

const counterTransactionOf = (manager: EntityManager, track: Track): CounterTransaction => ({
  counters: new CounterRepository(manager, track),
  manager,
});

interface Harness {
  readonly delivered: IEvent[];
  /** What had been delivered when the transaction committed, one entry per commit. */
  readonly deliveredAtCommit: number[];
  readonly manager: FakeManager;
}

/** `settle` is what the database does once the work has resolved: commit, or fail to. */
function harness(settle: () => Promise<void> = () => Promise.resolve()): Harness & {
  readonly dataSource: DataSource;
  readonly publisher: EventPublisher;
} {
  const delivered: IEvent[] = [];
  const deliveredAtCommit: number[] = [];
  const manager = new FakeManager([{ id: 'c-1', value: 0, version: 1 }]);
  const dataSource = {
    transaction: async (work: (m: EntityManager) => Promise<unknown>) => {
      const result = await work(manager as unknown as EntityManager);
      await settle();
      deliveredAtCommit.push(delivered.length);
      return result;
    },
  } as unknown as DataSource;
  // `commit()` empties the array it hands over, so it is copied as it arrives.
  const bus = {
    publishAll: (events: IEvent[]) => delivered.push(...events),
  } as unknown as EventBus;
  return { delivered, deliveredAtCommit, manager, dataSource, publisher: new EventPublisher(bus) };
}

function counterRunner(h: ReturnType<typeof harness>): TransactionRunner<CounterTransaction> {
  return new TransactionRunner(h.dataSource, h.publisher, counterTransactionOf);
}

async function incrementAndSave({ counters }: CounterTransaction): Promise<Counter> {
  const counter = await counters.findById('c-1');
  counter.increment();
  await counters.save(counter);
  return counter;
}

describe('TransactionRunner', () => {
  it('publishes a written aggregate’s events once the transaction has committed, not before', async () => {
    const h = harness();
    await counterRunner(h).run(incrementAndSave);

    expect(h.deliveredAtCommit).toEqual([0]);
    expect(h.delivered).toEqual([new Incremented('c-1', 1)]);
  });

  it('publishes nothing when the work fails after the save', async () => {
    const h = harness();
    const run = counterRunner(h).run(async (transaction) => {
      await incrementAndSave(transaction);
      throw new Error('a later write failed');
    });

    await expect(run).rejects.toThrow('a later write failed');
    expect(h.delivered).toEqual([]);
  });

  it('publishes nothing when the commit itself fails', async () => {
    const h = harness(() => Promise.reject(new Error('serialization failure')));

    await expect(counterRunner(h).run(incrementAndSave)).rejects.toThrow('serialization failure');
    expect(h.delivered).toEqual([]);
  });

  it('publishes nothing for a replay, which answers without writing', async () => {
    const h = harness();
    const runner = counterRunner(h);
    await runner.run(incrementAndSave);

    await runner.run(() => Promise.resolve('the recorded answer'));

    expect(h.delivered).toHaveLength(1);
  });

  it('publishes nothing for an aggregate that was changed but never written', async () => {
    const h = harness();
    await counterRunner(h).run(async ({ counters }) => {
      (await counters.findById('c-1')).increment();
    });

    expect(h.delivered).toEqual([]);
  });

  it('publishes every aggregate the transaction wrote, a write that keeps the version included', async () => {
    const h = harness();
    h.manager.rows.set('c-2', { id: 'c-2', value: 10, version: 4 });

    await counterRunner(h).run(async (transaction) => {
      await incrementAndSave(transaction);
      const other = await transaction.counters.findById('c-2');
      other.increment();
      await transaction.counters.bump(other);
    });

    expect(h.delivered).toEqual([new Incremented('c-1', 1), new Incremented('c-2', 11)]);
    expect(h.manager.rows.get('c-2')).toEqual({ id: 'c-2', value: 11, version: 4 });
  });

  it('saves one aggregate twice in a transaction against the version it last wrote', async () => {
    const h = harness();
    await counterRunner(h).run(async ({ counters }) => {
      const counter = await counters.findById('c-1');
      counter.increment();
      await counters.save(counter);
      counter.increment();
      await counters.save(counter);
    });

    expect(h.manager.rows.get('c-1')).toEqual({ id: 'c-1', value: 2, version: 3 });
    expect(h.delivered).toEqual([new Incremented('c-1', 1), new Incremented('c-1', 2)]);
  });

  it('refuses a save when another command committed since the load, naming the row as it stands', async () => {
    const h = harness();
    const refusal = await counterRunner(h)
      .run(async ({ counters }) => {
        const counter = await counters.findById('c-1');
        h.manager.rows.set('c-1', { id: 'c-1', value: 7, version: 2 });
        counter.increment();
        await counters.save(counter);
      })
      .catch((error: unknown) => error);

    expect(isDomainError(refusal) && [refusal.code, refusal.params]).toEqual([
      DomainErrorCode.STATE_CONFLICT,
      { version: 2 },
    ]);
    expect(h.delivered).toEqual([]);
  });

  it('runs two transactions in one command, each publishing on its own commit', async () => {
    const h = harness();
    const runner = counterRunner(h);

    await runner.run(incrementAndSave);
    await runner.run(incrementAndSave);

    expect(h.deliveredAtCommit).toEqual([0, 1]);
    expect(h.delivered).toEqual([new Incremented('c-1', 1), new Incremented('c-1', 2)]);
  });

  it('refuses a transaction opened inside another, and publishes nothing of the outer one', async () => {
    const h = harness();
    const runner = counterRunner(h);

    const nested = runner.run(async (transaction) => {
      await incrementAndSave(transaction);
      return runner.run(() => Promise.resolve());
    });

    await expect(nested).rejects.toThrow('does not nest');
    expect(h.delivered).toEqual([]);
  });

  it('does not take two concurrent commands for a nested one', async () => {
    const h = harness();
    const runner = counterRunner(h);

    await expect(
      Promise.all([runner.run(() => Promise.resolve(1)), runner.run(() => Promise.resolve(2))]),
    ).resolves.toEqual([1, 2]);
  });

  it('hands `work` what the factory built, so a class instance keeps its methods and getters', async () => {
    class ClassTransaction implements TransactionScope {
      public constructor(
        readonly manager: EntityManager,
        private readonly track: Track,
      ) {}

      public get counters(): CounterRepository {
        return new CounterRepository(this.manager, this.track);
      }

      public holds(): string {
        return 'a method on the prototype';
      }
    }
    const h = harness();
    const runner = new TransactionRunner(
      h.dataSource,
      h.publisher,
      (manager, track) => new ClassTransaction(manager, track),
    );

    const held = await runner.run(async (transaction) => {
      await incrementAndSave({ counters: transaction.counters, manager: transaction.manager });
      return transaction.holds();
    });

    expect(held).toBe('a method on the prototype');
    expect(h.delivered).toEqual([new Incremented('c-1', 1)]);
  });

  it('refuses a factory that hands back another manager than the transaction’s', async () => {
    const h = harness();
    const elsewhere = new FakeManager() as unknown as EntityManager;
    const runner = new TransactionRunner(h.dataSource, h.publisher, (_manager, track) =>
      counterTransactionOf(elsewhere, track),
    );
    let ran = false;

    await expect(
      runner.run(() => {
        ran = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow("the transaction's own manager");
    expect(ran).toBe(false);
  });
});
