import type { UnitTestTree } from '@angular-devkit/schematics/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { LIGHTING, RUN_MS, repositoryTree, testRunner } from '#schematics/repository-tree';

const SRC = '/apps/lighting/src';

describe('aggregate', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    const runner = testRunner();
    const service = await runner.runSchematic('service', LIGHTING, repositoryTree());
    const rig = await runner.runSchematic(
      'aggregate',
      { app: 'lighting', module: 'rigs', name: 'rig' },
      service,
    );
    tree = await runner.runSchematic(
      'aggregate',
      { app: 'lighting', module: 'rigs', name: 'cue', plural: 'cueSheets', table: 'cue_sheet' },
      rig,
    );
  }, RUN_MS);

  it('writes the aggregate, its events, row, port, adapter, outbox mapping and spec', () => {
    for (const file of [
      'rig.aggregate.ts',
      'rig.aggregate.spec.ts',
      'rig.events.ts',
      'rig.entity.ts',
      'rig.repository.ts',
      'rig.typeorm-repository.ts',
      'record-rig-events.ts',
    ]) {
      expect(tree.exists(`${SRC}/rigs/${file}`), file).toBe(true);
    }
    expect(tree.readText(`${SRC}/rigs/rig.typeorm-repository.ts`)).toContain('saveVersioned(');
    expect(tree.readText(`${SRC}/rigs/cue.entity.ts`)).toContain("@Entity('cue_sheet')");
  });

  it('turns the transaction into an interface holding each repository, bound to its manager', () => {
    const transactions = tree.readText(`${SRC}/lighting-transactions.ts`);
    expect(transactions).toContain(
      'export interface LightingTransaction extends TransactionScope {',
    );
    expect(transactions).toContain('readonly rigs: RigRepository;');
    expect(transactions).toContain('readonly cueSheets: CueRepository;');
    expect(transactions).toContain(
      'function lightingTransactionOf(manager: EntityManager, track: Track): LightingTransaction',
    );
    expect(transactions).toMatch(
      /cueSheets: new TypeOrmCueRepository\(manager, track\),\s+rigs: new TypeOrmRigRepository\(manager, track\),\s+manager,/,
    );
  });

  it('registers each row and a migration later than the ones before it', () => {
    const dataSource = tree.readText(`${SRC}/data-source.ts`);
    expect(dataSource).toMatch(/entities: \[ProcessedMessage, OutboxEvent, RigRow, CueRow\]/);
    const stamps = tree
      .getDir(`${SRC}/migrations`)
      .subfiles.map((file) => Number(file.slice(0, 13)))
      .sort();
    expect(new Set(stamps).size).toBe(3);
    expect(tree.readText(`${SRC}/migrations/${String(stamps[2])}-cue.ts`)).toContain(
      'CREATE TABLE "cue_sheet"',
    );
  });

  it(
    'refuses an app that is not a service, and an aggregate that exists',
    async () => {
      const refusal = (options: Record<string, unknown>, on: UnitTestTree): Promise<string> =>
        testRunner()
          .runSchematic('aggregate', options, on)
          .then(
            () => '',
            (error: unknown) => String(error),
          );
      expect(await refusal({ app: 'nowhere', module: 'rigs', name: 'rig' }, tree)).toContain(
        'does not exist',
      );
      expect(await refusal({ app: 'lighting', module: 'rigs', name: 'rig' }, tree)).toContain(
        'exists already',
      );
    },
    RUN_MS,
  );
});
