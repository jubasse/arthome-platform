import {
  SchematicsException,
  apply,
  applyTemplates,
  chain,
  mergeWith,
  move,
  url,
  type Rule,
} from '@angular-devkit/schematics';

import { aggregateNames, type AggregateNames } from '#schematics/aggregate-names';
import { formatTouchedFiles } from '#schematics/format';
import { kebab, snake } from '#schematics/names';
import {
  addImports,
  addInterfaceMember,
  addParameter,
  addReturnedProperty,
  addToArrayProperty,
  renderImports,
} from '#schematics/source-file';
import {
  editText,
  existingApp,
  nextMigrationTimestamp,
  type AppNames,
} from '#schematics/workspace';

export interface AggregateOptions {
  readonly app: string;
  /** The feature directory under `src/`, created when absent. */
  readonly module: string;
  readonly name: string;
  /** Its repository's key in the transaction, `widgets` for `widget` unless given. */
  readonly plural?: string;
  readonly table?: string;
}

function wireIntoTransactions(names: AppNames, module: string, aggregate: AggregateNames): Rule {
  return (tree) => {
    const base = `./${module}/${aggregate.kebab}`;
    editText(tree, names.transactionsFile, (text) => {
      const withMember = addInterfaceMember(
        text,
        names.transactionScope,
        `readonly ${aggregate.collection}: ${aggregate.repository};`,
      );
      const withTrack = addParameter(withMember, names.transactionFactory, 'track: Track');
      const withRepository = addReturnedProperty(
        withTrack,
        names.transactionFactory,
        `${aggregate.collection}: new ${aggregate.typeOrmRepository}(manager, track)`,
      );
      return addImports(withRepository, [
        { name: 'Track', from: '@arthome-platform/transactions', typeOnly: true },
        { name: aggregate.repository, from: `${base}.repository.js`, typeOnly: true },
        { name: aggregate.typeOrmRepository, from: `${base}.typeorm-repository.js` },
      ]);
    });
  };
}

function wireIntoDataSource(
  names: AppNames,
  module: string,
  aggregate: AggregateNames,
  migration: string,
  migrationFile: string,
): Rule {
  return (tree) => {
    editText(tree, `${names.src}/data-source.ts`, (text) => {
      const withEntity = addToArrayProperty(
        text,
        { newExpression: 'DataSource' },
        'entities',
        aggregate.row,
      );
      const withMigration = addToArrayProperty(
        withEntity,
        { newExpression: 'DataSource' },
        'migrations',
        migration,
      );
      return addImports(withMigration, [
        { name: aggregate.row, from: `./${module}/${aggregate.kebab}.entity.js` },
        { name: migration, from: `./migrations/${migrationFile}.js` },
      ]);
    });
  };
}

export function aggregate(options: AggregateOptions): Rule {
  return (tree) => {
    const names = existingApp(tree, options.app);
    const module = kebab(options.module);
    const aggregateSpelled = aggregateNames(options.name, options.plural);
    const directory = `${names.src}/${module}`;
    if (tree.exists(`${directory}/${aggregateSpelled.kebab}.aggregate.ts`)) {
      throw new SchematicsException(
        `${directory}/${aggregateSpelled.kebab}.aggregate.ts exists already`,
      );
    }
    if (!tree.exists(names.transactionsFile)) {
      throw new SchematicsException(`${names.transactionsFile} does not exist`);
    }
    const timestamp = nextMigrationTimestamp(tree, names.src);
    const migration = `${aggregateSpelled.pascal}${timestamp}`;
    const migrationFile = `${timestamp}-${aggregateSpelled.kebab}`;
    const table = snake(options.table ?? options.name);

    const files = apply(url('./files'), [
      applyTemplates({
        ...aggregateSpelled,
        module,
        app: names,
        table,
        migration,
        migrationFile,
        imports: renderImports,
      }),
      move(names.src),
    ]);
    return chain([
      mergeWith(files),
      wireIntoTransactions(names, module, aggregateSpelled),
      wireIntoDataSource(names, module, aggregateSpelled, migration, migrationFile),
      formatTouchedFiles(),
    ]);
  };
}
