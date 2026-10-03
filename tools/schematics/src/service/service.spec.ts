import type { UnitTestTree } from '@angular-devkit/schematics/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { LIGHTING, RUN_MS, repositoryTree, testRunner } from '#schematics/repository-tree';

interface Manifest {
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
}

interface Topics {
  readonly topics: readonly { readonly name: string; readonly partitions: number }[];
}

interface Connector {
  readonly name: string;
  readonly config: Record<string, string>;
}

const json = <T>(tree: UnitTestTree, path: string): T => JSON.parse(tree.readText(path)) as T;

describe('service', () => {
  let before: UnitTestTree;
  let tree: UnitTestTree;

  beforeAll(async () => {
    before = repositoryTree();
    tree = await testRunner().runSchematic('service', LIGHTING, repositoryTree());
  }, RUN_MS);

  it('writes the three processes, their data source, migration, events table and suites', () => {
    const src = '/apps/lighting/src';
    for (const file of [
      'main.ts',
      'app.module.ts',
      'consumer.ts',
      'consumer.module.ts',
      'consumed-messages.ts',
      'sweeper.ts',
      'sweeper.module.ts',
      'sweeper-loop.ts',
      'data-source.ts',
      'lighting-events.ts',
      'lighting-transactions.ts',
      'boot.itest.ts',
      'itest/schema.ts',
    ]) {
      expect(tree.exists(`${src}/${file}`), file).toBe(true);
    }
    expect(tree.getDir(`${src}/migrations`).subfiles).toEqual([
      expect.stringMatching(/^\d{13}-initial\.ts$/),
    ]);
    expect(tree.readText(`${src}/lighting-events.ts`)).toContain(
      "type LightingTopic = 'lighting.rig' | 'lighting.cue';",
    );
    expect(tree.readText('/apps/lighting/.env.example')).toContain('PORT=3999');
  });

  it('pins every dependency as the sibling services do', () => {
    const ticketing = json<Manifest>(tree, '/apps/ticketing/package.json');
    const lighting = json<Manifest>(tree, '/apps/lighting/package.json');
    for (const [name, spec] of Object.entries(lighting.dependencies)) {
      expect(spec, name).toBe(ticketing.dependencies[name]);
    }
    expect(Object.keys(lighting.devDependencies)).toEqual([
      '@arthome-platform/testing',
      '@nestjs/testing',
    ]);
    for (const [name, spec] of Object.entries(lighting.devDependencies)) {
      expect(spec, name).toBe(ticketing.devDependencies[name]);
    }
  });

  it('declares its topics at their partitions, and its retry and dead-letter topics', () => {
    const added = json<Topics>(tree, '/infra/kafka/topics.json').topics.slice(
      json<Topics>(before, '/infra/kafka/topics.json').topics.length,
    );
    expect(added).toEqual([
      { name: 'arthome.lighting.rig', partitions: 3 },
      { name: 'arthome.lighting.cue', partitions: 6 },
      { name: 'arthome.lighting.retry', partitions: 3 },
      { name: 'arthome.lighting.dlq', partitions: 3 },
    ]);
  });

  it('copies a connector, renaming only the fields named after the service', () => {
    const copied = json<Connector>(tree, '/infra/debezium/lighting-outbox.json');
    const model = json<Connector>(tree, '/infra/debezium/catalog-outbox.json');
    expect(copied.name).toBe('lighting-outbox');
    const differing = Object.keys(model.config).filter(
      (key) => model.config[key] !== copied.config[key],
    );
    expect(differing.sort()).toEqual([
      'database.dbname',
      'publication.name',
      'slot.name',
      'topic.prefix',
    ]);
    expect(copied.config['slot.name']).toBe('arthome_lighting_outbox');
  });

  it('creates its database with the timeouts every other one takes', () => {
    const sql = tree.readText('/infra/postgres/init-databases.sql');
    expect(sql).toContain('CREATE DATABASE lighting OWNER arthome;');
    expect(sql).toMatch(/^ALTER DATABASE lighting +SET idle_in_transaction_session_timeout/m);
    expect(sql).toMatch(/^ALTER DATABASE lighting +SET statement_timeout/m);
  });

  it('adds it to the ops tools, the connector spec, the README and AGENTS.md', () => {
    expect(tree.readText('/tools/ops-check.mjs')).toContain("['lighting', 'lighting']");
    expect(tree.readText('/tools/purge-retention.mjs')).toMatch(
      /CONSUMERS = new Set\([^)]*'lighting'/,
    );
    expect(tree.readText('/tools/republish-outbox.mjs')).toMatch(/<[a-z|]*\|lighting>/);
    expect(tree.readText('/libs/messaging/src/connector-config.spec.ts')).toContain(
      "'lighting-outbox'",
    );
    expect(tree.readText('/README.md')).toContain('| `apps/lighting` |');
    const agents = tree.readText('/AGENTS.md');
    expect(agents).toMatch(/^pnpm --filter @arthome-platform\/lighting +run migration:run$/m);
    expect(agents).toMatch(/^for c in [a-z ]* lighting; do$/m);
  });

  it('keeps the name out of core when core has no such member, and names the gap', () => {
    expect(tree.readText('/apps/lighting/src/service.ts')).toContain(
      "export const SERVICE = 'lighting';",
    );
    expect(tree.readText('/apps/lighting/HANDOVER.md')).toContain('not a member of');
  });
});

describe('service, API alone', () => {
  it(
    'writes no consumer or sweeper, no failure topics, and no consumer in the tools',
    async () => {
      const tree = await testRunner().runSchematic(
        'service',
        { ...LIGHTING, consumer: false, sweeper: false },
        repositoryTree(),
      );
      const src = '/apps/lighting/src';
      for (const file of ['consumer.ts', 'consumed-messages.ts', 'delivery.ts', 'sweeper.ts']) {
        expect(tree.exists(`${src}/${file}`), file).toBe(false);
      }
      expect(tree.readText(`${src}/boot.itest.ts`)).not.toContain('kafkajs');
      expect(tree.readText('/infra/kafka/topics.json')).not.toContain('arthome.lighting.retry');
      expect(tree.readText('/tools/ops-check.mjs')).not.toContain("['lighting', 'lighting']");
      expect(json<Manifest>(tree, '/apps/lighting/package.json').dependencies).not.toHaveProperty(
        'kafkajs',
      );
    },
    RUN_MS,
  );
});

describe('service, named in core', () => {
  it(
    "reads its name from core's Service vocabulary, and declares no topic twice",
    async () => {
      const tree = await testRunner().runSchematic(
        'service',
        { ...LIGHTING, name: 'streaming', topics: 'run:12' },
        repositoryTree(),
      );
      expect(tree.readText('/apps/streaming/src/service.ts')).toContain(
        'export const SERVICE = Service.STREAMING;',
      );
      const names = json<Topics>(tree, '/infra/kafka/topics.json').topics.map(({ name }) => name);
      expect(names.filter((name) => name === 'arthome.streaming.run')).toHaveLength(1);
    },
    RUN_MS,
  );
});

describe('service, refused', () => {
  const refusal = (options: Record<string, unknown>): Promise<unknown> =>
    testRunner()
      .runSchematic('service', { ...LIGHTING, ...options }, repositoryTree())
      .then(
        () => undefined,
        (error: unknown) => error,
      );

  it(
    'refuses an app that exists, a port taken, a topic without partitions, a name of two words',
    async () => {
      expect(String(await refusal({ name: 'ticketing' }))).toContain('exists already');
      const ticketingPort = /^PORT=(\d+)$/m.exec(
        repositoryTree().readText('/apps/ticketing/.env.example'),
      )?.[1];
      expect(String(await refusal({ port: Number(ticketingPort) }))).toContain(
        "apps/ticketing's already",
      );
      expect(String(await refusal({ topics: 'rig' }))).toContain('not aggregate:partitions');
      expect(String(await refusal({ name: 'stage-lighting' }))).toMatch(/name/);
    },
    RUN_MS,
  );

  it(
    'refuses a name used outside apps/: a database, a topic, a connector, a consumer group',
    async () => {
      const search = String(await refusal({ name: 'search' }));
      expect(search).toContain('database search in infra/postgres/init-databases.sql');
      expect(search).toContain('topic arthome.search.retry in infra/kafka/topics.json');
      expect(search).toContain('topic arthome.search.dlq in infra/kafka/topics.json');
      expect(search).toContain('consumer group search in apps/search-indexer/src/main.ts');
      expect(String(await refusal({ name: 'identity' }))).toContain('database identity');
      expect(String(await refusal({ name: 'ticketing' }))).toContain(
        'consumer group ticketing in apps/ticketing/src/consumer.module.ts',
      );

      const legacy = repositoryTree();
      const catalog = JSON.parse(
        legacy.readText('/infra/debezium/catalog-outbox.json'),
      ) as Connector;
      legacy.create(
        '/infra/debezium/legacy-outbox.json',
        JSON.stringify({
          name: 'legacy-outbox',
          config: { ...catalog.config, 'slot.name': 'arthome_lighting_outbox' },
        }),
      );
      legacy.create(
        '/apps/legacy/src/main.ts',
        "const GROUP = 'lighting';\nawait runConsumers({ kafka, producer, service: GROUP, sources });\n",
      );
      const lighting = String(
        await testRunner()
          .runSchematic('service', LIGHTING, legacy)
          .then(
            () => undefined,
            (error: unknown) => error,
          ),
      );
      expect(lighting).toContain('connector infra/debezium/legacy-outbox.json (slot.name)');
      expect(lighting).toContain('consumer group lighting in apps/legacy/src/main.ts');
    },
    RUN_MS,
  );

  it(
    'owns a topic declared before the service only at its partitions, and no failure topic',
    async () => {
      for (const topics of ['run:6', 'session:3']) {
        expect(String(await refusal({ name: 'streaming', topics }))).toContain(
          'topic arthome.streaming.run in infra/kafka/topics.json (--topics run:12 owns it)',
        );
      }
      expect(String(await refusal({ topics: 'rig:3,retry:3' }))).toContain('failure topic');
    },
    RUN_MS,
  );

  it(
    'schedules pnpm install unless told not to',
    async () => {
      const runner = testRunner();
      await runner.runSchematic('service', { ...LIGHTING, skipInstall: false }, repositoryTree());
      expect(runner.tasks.map(({ name }) => name)).toEqual(['node-package']);
    },
    RUN_MS,
  );
});
