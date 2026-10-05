import {
  SchematicsException,
  apply,
  applyTemplates,
  chain,
  mergeWith,
  move,
  url,
  type Rule,
  type Tree,
} from '@angular-devkit/schematics';

import { ensureFeatureModule, register } from '#schematics/feature-module';
import { formatTouchedFiles } from '#schematics/format';
import { kebab, snake, spellings } from '#schematics/names';
import {
  addImports,
  addProperty,
  addStatementBefore,
  addToArrayProperty,
  addToCollection,
  hasDeclaration,
  hasProperty,
  renderImports,
} from '#schematics/source-file';
import {
  editText,
  existingApp,
  nextMigrationTimestamp,
  readText,
  type AppNames,
} from '#schematics/workspace';

export interface ConsumerHandlerOptions {
  readonly app: string;
  readonly module: string;
  /** The command the message becomes, a verb phrase: record-date-drafted. */
  readonly name: string;
  readonly topic: string;
  /** The `type` header it handles: catalog.date.drafted.v1. */
  readonly type: string;
  /** Its Protobuf schema in `@arthome-platform/events`: DateDraftedSchema. */
  readonly schema: string;
  /** The event's string field naming what the fact is about, its partition key: dateId. */
  readonly key: string;
  readonly occurredAt: string;
  readonly table?: string;
}

const OCCURRED_AT_OF = `/** A fact with no \`occurred_at\` cannot be ordered against another: it does not read as its type. */
function occurredAtOf(timestamp: Timestamp | undefined): Date {
  if (timestamp === undefined) throw new Error('no occurred_at');
  return timestampDate(timestamp);
}`;

function readerOf(options: ConsumerHandlerOptions, command: string): string {
  return `(value, delivery) => {
    const event = fromBinary(${options.schema}, value);
    return new ${command}(delivery, {
      ${options.key}: event.${options.key},
      occurredAt: occurredAtOf(event.${options.occurredAt}),
    });
  }`;
}

/** The type's reader, turning its bytes into the command, in the app's `consumed-messages.ts`. */
function readType(
  names: AppNames,
  module: string,
  options: ConsumerHandlerOptions,
  command: string,
  file: string,
): Rule {
  return (tree: Tree) => {
    editText(tree, `${names.src}/consumed-messages.ts`, (text) => {
      const withReader = addProperty(
        text,
        { variable: 'READERS' },
        options.type,
        readerOf(options, command),
      );
      const withHelper = hasDeclaration(withReader, 'occurredAtOf')
        ? withReader
        : addStatementBefore(
            withReader,
            `apply${spellings(names.app).pascal}Message`,
            OCCURRED_AT_OF,
          );
      return addImports(withHelper, [
        { name: options.schema, from: '@arthome-platform/events' },
        { name: 'fromBinary', from: '@bufbuild/protobuf' },
        { name: 'timestampDate', from: '@bufbuild/protobuf/wkt' },
        { name: 'Timestamp', from: '@bufbuild/protobuf/wkt', typeOnly: true },
        { name: command, from: `./${module}/${file}.command.js` },
      ]);
    });
  };
}

/** The topic subscribed, and the handler provided, in the consumer process. */
function consume(
  names: AppNames,
  module: string,
  topic: string,
  handler: string,
  file: string,
): Rule {
  return (tree: Tree) => {
    editText(tree, `${names.src}/consumer.module.ts`, (text) =>
      addToCollection(text, 'CONSUMED_TOPICS', `'${topic}'`),
    );
    const feature = ensureFeatureModule(tree, names, module, {
      file: `${module}-consumer`,
      purpose: 'What the consumer process dispatches to.',
      root: 'consumer.module',
      clock: false,
    });
    register(tree, feature, 'providers', handler, `./${file}.handler.js`);
  };
}

function registerMigration(names: AppNames, migration: string, migrationFile: string): Rule {
  return (tree: Tree) => {
    editText(tree, `${names.src}/data-source.ts`, (text) =>
      addImports(
        addToArrayProperty(text, { newExpression: 'DataSource' }, 'migrations', migration),
        [{ name: migration, from: `./migrations/${migrationFile}.js` }],
      ),
    );
  };
}

export function consumerHandler(options: ConsumerHandlerOptions): Rule {
  return (tree) => {
    const names = existingApp(tree, options.app);
    const consumedMessages = `${names.src}/consumed-messages.ts`;
    for (const required of ['consumer.module.ts', 'consumed-messages.ts', 'delivery.ts']) {
      if (!tree.exists(`${names.src}/${required}`)) {
        throw new SchematicsException(
          `${names.src}/${required} does not exist: generate the service with --consumer`,
        );
      }
    }
    if (!/^arthome\.[a-z][a-z0-9_-]*\.[a-z][a-z0-9_]*$/.test(options.topic)) {
      throw new SchematicsException(`--topic "${options.topic}": arthome.<context>.<aggregate>`);
    }
    if (!/\.v\d+$/.test(options.type)) {
      throw new SchematicsException(
        `--type "${options.type}": a versioned type, such as catalog.date.drafted.v1`,
      );
    }
    if (!/^[A-Z][A-Za-z0-9]*Schema$/.test(options.schema)) {
      throw new SchematicsException(
        `--schema "${options.schema}": a Protobuf schema, such as DateDraftedSchema`,
      );
    }
    // One reader per type: a second handler would be registered and never dispatched to.
    if (hasProperty(readText(tree, consumedMessages), { variable: 'READERS' }, options.type)) {
      throw new SchematicsException(
        `${consumedMessages}: READERS reads '${options.type}' already; extend its handler instead`,
      );
    }
    const module = kebab(options.module);
    const command = spellings(options.name);
    const directory = `${names.src}/${module}`;
    if (tree.exists(`${directory}/${command.kebab}.command.ts`)) {
      throw new SchematicsException(`${directory}/${command.kebab}.command.ts exists already`);
    }
    const fact = options.schema.replace(/Schema$/, '');
    const table = snake(options.table ?? `${fact}_fact`);
    const timestamp = nextMigrationTimestamp(tree, names.src);
    const migration = `${spellings(table).pascal}${timestamp}`;
    const migrationFile = `${timestamp}-${kebab(table)}`;

    const files = apply(url('./files'), [
      applyTemplates({
        ...options,
        module,
        file: command.kebab,
        command,
        fact,
        table,
        keyColumn: snake(options.key),
        consumerModule: `${spellings(module).pascal}ConsumerModule`,
        consumerModuleFile: `${module}-consumer.module`,
        applyMessage: `apply${spellings(names.app).pascal}Message`,
        app: names,
        migration,
        migrationFile,
        database: `${snake(names.app)}_${command.snake}_itest`.slice(0, 63),
        imports: renderImports,
      }),
      move(names.src),
    ]);
    return chain([
      mergeWith(files),
      readType(names, module, options, command.pascal, command.kebab),
      consume(names, module, options.topic, `${command.pascal}Handler`, command.kebab),
      registerMigration(names, migration, migrationFile),
      formatTouchedFiles(),
    ]);
  };
}
