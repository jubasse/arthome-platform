import { posix } from 'node:path';

import {
  SchematicsException,
  apply,
  applyTemplates,
  chain,
  filter,
  mergeWith,
  move,
  url,
  type Rule,
  type SchematicContext,
  type Tree,
} from '@angular-devkit/schematics';
import { NodePackageInstallTask } from '@angular-devkit/schematics/tasks/index.js';

import { formatTouchedFiles } from '#schematics/format';
import { spellings } from '#schematics/names';
import {
  addToCollection,
  addToSortedStringArray,
  constantExpression,
  importSourceOf,
  propertyPassedTo,
} from '#schematics/source-file';
import {
  editText,
  nextMigrationTimestamp,
  readJson,
  readText,
  serviceVocabulary,
  siblingPins,
  writeJson,
  type ServiceVocabulary,
} from '#schematics/workspace';

export interface ServiceOptions {
  readonly name: string;
  readonly port: number;
  /** `aggregate:partitions`, comma-separated: `order:6,account:3`. */
  readonly topics: string;
  readonly consumer: boolean;
  readonly sweeper: boolean;
  readonly skipInstall: boolean;
}

interface Topic {
  readonly aggregate: string;
  readonly partitions: number;
}

interface DeclaredTopics {
  readonly topics: readonly { readonly name: string; readonly partitions: number }[];
}

/** events.md §3: a context's retry and dead-letter topics take 3 partitions, like every other's. */
const FAILURE_TOPIC_PARTITIONS = 3;
const FAILURE_TOPICS = ['retry', 'dlq'];

const DATABASES = '/infra/postgres/init-databases.sql';
const TOPICS = '/infra/kafka/topics.json';
const CONNECTORS = '/infra/debezium';
/** A connector's fields named after its service; the files differ in nothing else. */
const NAMED_AFTER_SERVICE = ['database.dbname', 'topic.prefix', 'slot.name', 'publication.name'];
/** What starts a service's consumer groups, named after its `service`: `runConsumers` (consume.ts). */
const CONSUMER_HOSTS = ['ConsumerHostModule.forRoot', 'runConsumers'];

const CONSUMER_FILES = [
  '/consumer.ts',
  '/consumer.module.ts',
  '/consumed-messages.ts',
  '/delivery.ts',
];
const SWEEPER_FILES = ['/sweeper.ts', '/sweeper.module.ts', '/sweeper-loop.ts'];

/** Whether the template at `path` renders `file`: filters see it before `.template` is dropped. */
const renders =
  (path: string) =>
  (file: string): boolean =>
    path.replace(/\.template$/, '').endsWith(file);

const DEPENDENCIES = [
  '@arthome-platform/config',
  '@arthome-platform/events',
  '@arthome-platform/http-edge',
  '@arthome-platform/messaging',
  '@arthome-platform/transactions',
  '@arthome/core',
  '@bufbuild/protobuf',
  '@nestjs/common',
  '@nestjs/core',
  '@nestjs/cqrs',
  '@nestjs/platform-fastify',
  '@nestjs/typeorm',
  'pg',
  'reflect-metadata',
  'typeorm',
  'zod',
];
const CONSUMER_DEPENDENCIES = ['kafkajs'];
const DEV_DEPENDENCIES = ['@arthome-platform/testing', '@nestjs/testing'];

function topicsOf(option: string): Topic[] {
  const topics = option
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const parsed = /^([a-z][a-z0-9_]*):([1-9]\d*)$/.exec(entry);
      if (parsed === null) {
        throw new SchematicsException(
          `--topics: "${entry}" is not aggregate:partitions, such as order:6 (events.md §3)`,
        );
      }
      const aggregate = parsed[1] ?? '';
      if (FAILURE_TOPICS.includes(aggregate)) {
        throw new SchematicsException(`--topics: "${aggregate}" names a consumer's failure topic`);
      }
      return { aggregate, partitions: Number(parsed[2]) };
    });
  if (topics.length === 0) throw new SchematicsException('--topics names no topic');
  return topics;
}

function refuseName(name: string): void {
  if (!/^[a-z][a-z0-9]*$/.test(name)) {
    throw new SchematicsException(
      `--name "${name}": one lowercase word, since it names a database, a slot and a topic prefix`,
    );
  }
}

interface Connector {
  readonly name: string;
  readonly config: Record<string, string>;
}

/**
 * Copied from the alphabetically-first connector, the fields named after its service renamed:
 *   `connector-config.spec.ts` holds that they differ in nothing else.
 */
function connectorOf(tree: Tree, name: string): Connector {
  const model = tree
    .getDir(CONNECTORS)
    .subfiles.filter((file) => file.endsWith('-outbox.json'))
    .sort()[0];
  if (model === undefined) {
    throw new SchematicsException('no infra/debezium/*-outbox.json to copy');
  }
  const source = readJson<Connector>(tree, `${CONNECTORS}/${model}`);
  const modelService = source.config['database.dbname'] ?? '';
  const renamed = (value: string): string => value.split(modelService).join(name);
  const config = Object.fromEntries(
    Object.entries(source.config).map(([key, value]) => [
      key,
      NAMED_AFTER_SERVICE.includes(key) ? renamed(value) : value,
    ]),
  );
  return { name: `${name}-outbox`, config };
}

function connectorUses(tree: Tree, name: string): string[] {
  const wanted = connectorOf(tree, name);
  return tree
    .getDir(CONNECTORS)
    .subfiles.filter((file) => file.endsWith('.json'))
    .flatMap((file) => {
      const existing = readJson<Partial<Connector>>(tree, `${CONNECTORS}/${file}`);
      const shared = [
        ...(existing.name === wanted.name ? ['name'] : []),
        ...NAMED_AFTER_SERVICE.filter(
          (key) =>
            existing.config?.[key] === wanted.config[key] && wanted.config[key] !== undefined,
        ),
      ];
      return shared.length === 0 ? [] : [`connector infra/debezium/${file} (${shared.join(', ')})`];
    });
}

/**
 * When nothing else bears the name, its topics were declared before the service was built, as
 *   `arthome.streaming.run` is for catalog to consume: each is its own when `--topics` claims it
 *   at its partitions. Otherwise they are a running service's.
 */
function topicUses(
  tree: Tree,
  name: string,
  topics: readonly Topic[],
  declaredAhead: boolean,
): string[] {
  const prefix = `arthome.${name}.`;
  return readJson<DeclaredTopics>(tree, TOPICS)
    .topics.filter((topic) => topic.name.startsWith(prefix))
    .flatMap(({ name: declared, partitions }) => {
      const aggregate = declared.slice(prefix.length);
      const claimable = declaredAhead && !FAILURE_TOPICS.includes(aggregate);
      const claimed = topics.find((topic) => topic.aggregate === aggregate);
      if (claimable && claimed?.partitions === partitions) return [];
      const claim = claimable ? ` (--topics ${aggregate}:${partitions} owns it)` : '';
      return [`topic ${declared} in infra/kafka/topics.json${claim}`];
    });
}

/** A string, `Service.X`, or a `const` the file declares or imports from a sibling, as its value. */
function valueOf(
  tree: Tree,
  path: string,
  expression: string,
  members: ReadonlyMap<string, string>,
): string {
  const literal = /^(['"`])(.*)\1$/.exec(expression)?.[2];
  if (literal !== undefined) return literal;
  const member = members.get(expression);
  if (member !== undefined) return member;
  const text = tree.readText(path);
  const bound = constantExpression(text, expression);
  if (bound !== null) return valueOf(tree, path, bound, members);
  const from = importSourceOf(text, expression);
  if (from?.startsWith('.') !== true) return expression;
  const imported = posix.join(posix.dirname(path), from.replace(/\.js$/, '.ts'));
  return tree.exists(imported) ? valueOf(tree, imported, expression, members) : expression;
}

function consumerGroupUses(tree: Tree, name: string, vocabulary: ServiceVocabulary): string[] {
  const members = new Map(
    Object.entries(vocabulary).map(([member, value]) => [`Service.${member}`, value]),
  );
  const uses: string[] = [];
  for (const app of tree.getDir('/apps').subdirs) {
    tree.getDir(`/apps/${app}/src`).visit((path) => {
      if (!path.endsWith('.ts') || /\.(spec|itest)\.ts$/.test(path)) return;
      const text = tree.readText(path);
      const groups = CONSUMER_HOSTS.filter((callee) => text.includes(callee)).flatMap((callee) =>
        propertyPassedTo(text, callee, 'service').map((value) =>
          valueOf(tree, path, value, members),
        ),
      );
      if (groups.includes(name)) uses.push(`consumer group ${name} in ${path.slice(1)}`);
    });
  }
  return uses;
}

/** Everything already named `name`: refused all at once, since a service shares none of them. */
function refuseUsedName(
  tree: Tree,
  { name }: ServiceOptions,
  topics: readonly Topic[],
  vocabulary: ServiceVocabulary,
): void {
  const app = tree.getDir('/apps').subdirs.some((directory) => directory === name)
    ? [`apps/${name} exists already`]
    : [];
  const database = new RegExp(`^(CREATE|ALTER) DATABASE ${name}\\s`, 'm').test(
    readText(tree, DATABASES),
  )
    ? [`database ${name} in infra/postgres/init-databases.sql`]
    : [];
  const connectors = connectorUses(tree, name);
  const groups = consumerGroupUses(tree, name, vocabulary);
  const declaredAhead = [...app, ...database, ...connectors, ...groups].length === 0;
  const uses = [
    ...app,
    ...database,
    ...topicUses(tree, name, topics, declaredAhead),
    ...connectors,
    ...groups,
  ];
  if (uses.length > 0) {
    throw new SchematicsException(`--name ${name} is taken: ${uses.join('; ')}`);
  }
}

function refusePort(tree: Tree, { port }: ServiceOptions): void {
  for (const app of tree.getDir('/apps').subdirs) {
    const example = `/apps/${app}/.env.example`;
    if (tree.exists(example) && new RegExp(`^PORT=${port}$`, 'm').test(tree.readText(example))) {
      throw new SchematicsException(`--port ${port} is apps/${app}'s already`);
    }
  }
}

function manifest(options: ServiceOptions): Rule {
  return (tree) => {
    const dependencies = siblingPins(tree, [
      ...DEPENDENCIES,
      ...(options.consumer ? CONSUMER_DEPENDENCIES : []),
    ]);
    const sorted = (pins: Record<string, string>): Record<string, string> =>
      Object.fromEntries(Object.entries(pins).sort(([a], [b]) => (a < b ? -1 : 1)));
    writeJson(tree, `/apps/${options.name}/package.json`, {
      name: `@arthome-platform/${options.name}`,
      version: '0.0.0',
      private: true,
      type: 'module',
      description: `The ${options.name} service.`,
      license: 'UNLICENSED',
      scripts: {
        build: 'tsc -p tsconfig.build.json',
        typecheck: 'tsc --noEmit -p tsconfig.json',
        test: 'vitest run',
        'test:integration': 'vitest run --config vitest.integration.config.mjs',
        'migration:run': 'pnpm run build && typeorm migration:run -d dist/data-source.js',
        'migration:revert': 'pnpm run build && typeorm migration:revert -d dist/data-source.js',
      },
      dependencies: sorted(dependencies),
      devDependencies: sorted(siblingPins(tree, DEV_DEPENDENCIES)),
    });
  };
}

/** Its database, with the timeouts every other one takes. */
function database({ name }: ServiceOptions): Rule {
  return (tree) => {
    editText(tree, DATABASES, (text) => {
      const lines = text.split('\n');
      const afterLast = (pattern: RegExp, line: (padded: string) => string): void => {
        const indices = lines.flatMap((candidate, index) =>
          pattern.test(candidate) ? [index] : [],
        );
        const last = indices[indices.length - 1];
        if (last === undefined) throw new Error(`no line matches ${String(pattern)}`);
        const column = /^ALTER DATABASE (\S+\s+)SET/.exec(lines[last] ?? '')?.[1]?.length ?? 0;
        lines.splice(last + 1, 0, line(name.padEnd(Math.max(column - 1, name.length)) + ' '));
      };
      afterLast(/^CREATE DATABASE /, () => `CREATE DATABASE ${name} OWNER arthome;`);
      afterLast(
        /^ALTER DATABASE \S+\s+SET idle_in_transaction_session_timeout/,
        (padded) => `ALTER DATABASE ${padded}SET idle_in_transaction_session_timeout = '60s';`,
      );
      afterLast(
        /^ALTER DATABASE \S+\s+SET statement_timeout/,
        (padded) => `ALTER DATABASE ${padded}SET statement_timeout = '30s';`,
      );
      return lines.join('\n');
    });
  };
}

function connector({ name }: ServiceOptions): Rule {
  return (tree) => {
    writeJson(tree, `${CONNECTORS}/${name}-outbox.json`, connectorOf(tree, name));
  };
}

function kafkaTopics({ name, consumer }: ServiceOptions, topics: readonly Topic[]): Rule {
  return (tree) => {
    const declared = readJson<DeclaredTopics>(tree, TOPICS);
    const wanted = [
      ...topics.map(({ aggregate, partitions }) => ({
        name: `arthome.${name}.${aggregate}`,
        partitions,
      })),
      ...(consumer
        ? FAILURE_TOPICS.map((suffix) => ({
            name: `arthome.${name}.${suffix}`,
            partitions: FAILURE_TOPIC_PARTITIONS,
          }))
        : []),
    ];
    const existing = new Set(declared.topics.map((topic) => topic.name));
    const added = wanted.filter((topic) => !existing.has(topic.name));
    writeJson(tree, TOPICS, { ...declared, topics: [...declared.topics, ...added] });
  };
}

/** The ops tools learn the service as a publisher, and as a consumer when it is one. */
function operations({ name, consumer }: ServiceOptions): Rule {
  return (tree, context) => {
    const quoted = `'${name}'`;
    const tool = (path: string, edit: (text: string) => string): void => {
      if (!tree.exists(path)) {
        context.logger.warn(`${path} is missing: add ${name} to its sets by hand`);
        return;
      }
      editText(tree, path, edit);
    };
    tool('/tools/ops-check.mjs', (text) => {
      const published = addToCollection(text, 'PUBLISHERS', quoted);
      return consumer
        ? addToCollection(published, 'CONSUMERS', `[${quoted}, ${quoted}]`)
        : published;
    });
    tool('/tools/purge-retention.mjs', (text) => {
      const published = addToCollection(text, 'PUBLISHERS', quoted);
      return consumer ? addToCollection(published, 'CONSUMERS', quoted) : published;
    });
    tool('/tools/republish-outbox.mjs', (text) =>
      addToCollection(text, 'PUBLISHERS', quoted).replace(
        /(Usage: .*<)([a-z|-]+)>/,
        (whole, head: string, names: string) =>
          names.split('|').includes(name) ? whole : `${head}${names}|${name}>`,
      ),
    );
    editText(tree, '/libs/messaging/src/connector-config.spec.ts', (text) =>
      addToSortedStringArray(text, /-outbox$/, `${name}-outbox`),
    );
  };
}

/** The README's row and AGENTS.md's migration and connector lines, where their anchors are. */
function documentation({ name }: ServiceOptions): Rule {
  return (tree, context) => {
    const anchored = (path: string, what: string, edit: (text: string) => string | null): void => {
      const text = tree.readText(path);
      const edited = edit(text);
      if (edited === null) context.logger.warn(`${path}: ${what} not found, add it by hand`);
      else if (edited !== text) tree.overwrite(path, edited);
    };
    anchored('/README.md', 'the table of built apps', (text) => {
      if (text.includes(`| \`apps/${name}\` |`)) return text;
      const rows = [...text.matchAll(/^\| `apps\/[^`]+` \|.*$/gm)];
      const last = rows[rows.length - 1];
      if (last === undefined) return null;
      const at = last.index + last[0].length;
      const row = `| \`apps/${name}\` | generated, nothing built yet: \`apps/${name}/HANDOVER.md\` |`;
      return `${text.slice(0, at)}\n${row}${text.slice(at)}`;
    });
    anchored('/AGENTS.md', 'the migration:run lines', (text) => {
      if (text.includes(`@arthome-platform/${name} `)) return text;
      const lines = [
        ...text.matchAll(/^(pnpm --filter @arthome-platform\/\S+\s+)run migration:run.*$/gm),
      ];
      const last = lines[lines.length - 1];
      if (last === undefined) return null;
      const column = (last[1] ?? '').length - 1;
      const line = `${`pnpm --filter @arthome-platform/${name}`.padEnd(column)} run migration:run`;
      const at = last.index + last[0].length;
      return `${text.slice(0, at)}\n${line}${text.slice(at)}`;
    });
    anchored('/AGENTS.md', 'the connector loop', (text) => {
      const loop = /^for c in ([a-z ]+); do$/m.exec(text);
      if (loop === null) return null;
      const services = (loop[1] ?? '').split(' ');
      if (services.includes(name)) return text;
      return text.replace(loop[0], `for c in ${[...services, name].join(' ')}; do`);
    });
  };
}

function install(options: ServiceOptions): Rule {
  return (_tree: Tree, context: SchematicContext) => {
    if (!options.skipInstall) {
      context.addTask(new NodePackageInstallTask({ packageManager: 'pnpm' }));
    }
  };
}

export function service(options: ServiceOptions): Rule {
  return async (tree) => {
    refuseName(options.name);
    const topics = topicsOf(options.topics);
    const vocabulary = await serviceVocabulary();
    refuseUsedName(tree, options, topics, vocabulary);
    refusePort(tree, options);
    const member =
      Object.entries(vocabulary).find(([, value]) => value === options.name)?.[0] ?? null;
    const files = apply(url('./files'), [
      filter((path) => options.consumer || !CONSUMER_FILES.some(renders(path))),
      filter((path) => options.sweeper || !SWEEPER_FILES.some(renders(path))),
      applyTemplates({
        ...spellings(options.name),
        name: options.name,
        port: options.port,
        consumer: options.consumer,
        sweeper: options.sweeper,
        serviceMember: member,
        topics,
        initialMigration: nextMigrationTimestamp(tree, `/apps/${options.name}/src`),
      }),
      move('/'),
    ]);
    return chain([
      mergeWith(files),
      manifest(options),
      database(options),
      connector(options),
      kafkaTopics(options, topics),
      operations(options),
      documentation(options),
      formatTouchedFiles(),
      install(options),
    ]);
  };
}
