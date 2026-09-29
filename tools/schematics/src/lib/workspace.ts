import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SchematicsException, type Tree } from '@angular-devkit/schematics';

import { camel, constant, kebab, pascal } from '#schematics/names';

export function readText(tree: Tree, path: string): string {
  const text = tree.exists(path) ? tree.readText(path) : null;
  if (text === null) throw new SchematicsException(`${path} does not exist`);
  return text;
}

/** `edit` over the file's text, written back only when it changed. */
export function editText(tree: Tree, path: string, edit: (text: string) => string): void {
  const text = readText(tree, path);
  let edited: string;
  try {
    edited = edit(text);
  } catch (error) {
    throw new SchematicsException(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (edited !== text) tree.overwrite(path, edited);
}

export function readJson<T>(tree: Tree, path: string): T {
  return JSON.parse(readText(tree, path)) as T;
}

export function writeJson(tree: Tree, path: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (tree.exists(path)) tree.overwrite(path, text);
  else tree.create(path, text);
}

interface CoreManifest {
  readonly exports: { readonly '.': { readonly import: string } };
}

/**
 * The member of core's `Service` vocabulary named `name`, or null when core has none. Loaded from
 *   the `import` target its manifest declares: Vitest runs its workers under the `@arthome/source`
 *   condition, which resolves the package to TypeScript that Node refuses to strip in node_modules.
 */
export async function serviceMemberOf(name: string): Promise<string | null> {
  const manifestPath = createRequire(import.meta.url).resolve('@arthome/core/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CoreManifest;
  const entry = pathToFileURL(join(dirname(manifestPath), manifest.exports['.'].import)).href;
  const { Service } = (await import(entry)) as { Service: Readonly<Record<string, string>> };
  const member = Object.entries(Service).find(([, value]) => value === name);
  return member === undefined ? null : member[0];
}

export interface AppNames {
  readonly app: string;
  readonly root: string;
  readonly src: string;
  /** `SampleTransactions`, `sampleTransactionOf`, `SampleTransaction`, their file. */
  readonly transactionsClass: string;
  readonly transactionsModule: string;
  readonly transactionScope: string;
  readonly transactionFactory: string;
  readonly transactionsFile: string;
  readonly eventWriter: string;
  readonly eventType: string;
  readonly eventsFile: string;
  /** `itest/schema.ts`'s migration plan. */
  readonly schema: string;
}

/** An app this collection generated, or one shaped like it: refused when it is not. */
export function existingApp(tree: Tree, app: string): AppNames {
  const root = `/apps/${kebab(app)}`;
  for (const required of ['package.json', 'src/data-source.ts', 'src/clock.ts']) {
    if (!tree.exists(`${root}/${required}`)) {
      throw new SchematicsException(
        `${root}/${required} does not exist: --app names a service under apps/ shaped like ticketing`,
      );
    }
  }
  const name = kebab(app);
  return {
    app: name,
    root,
    src: `${root}/src`,
    transactionsClass: `${pascal(name)}Transactions`,
    transactionsModule: `${pascal(name)}TransactionsModule`,
    transactionScope: `${pascal(name)}Transaction`,
    transactionFactory: `${camel(name)}TransactionOf`,
    transactionsFile: `${root}/src/${name}-transactions.ts`,
    eventWriter: `write${pascal(name)}Event`,
    eventType: `${pascal(name)}Event`,
    eventsFile: `${root}/src/${name}-events.ts`,
    schema: `${constant(name)}_SCHEMA`,
  };
}

/** Each dependency's specifier as the sibling services pin it; two different pins are refused. */
export function siblingPins(tree: Tree, dependencies: readonly string[]): Record<string, string> {
  const manifests = tree
    .getDir('/apps')
    .subdirs.map((directory) => `/apps/${directory}/package.json`)
    .filter((path) => tree.exists(path))
    .map((path) => ({ path, manifest: readJson<Record<string, unknown>>(tree, path) }));
  const pins: Record<string, string> = {};
  for (const dependency of dependencies) {
    const found = new Map<string, string>();
    for (const { path, manifest } of manifests) {
      for (const field of ['dependencies', 'devDependencies']) {
        const spec = (manifest[field] as Record<string, string> | undefined)?.[dependency];
        if (spec !== undefined) found.set(spec, path);
      }
    }
    if (found.size === 0) {
      throw new SchematicsException(
        `no service under apps/ depends on ${dependency} to copy its pin`,
      );
    }
    if (found.size > 1) {
      throw new SchematicsException(
        `the services pin ${dependency} differently (${[...found.entries()].map(([spec, path]) => `${spec} in ${path}`).join(', ')}): align them first`,
      );
    }
    pins[dependency] = [...found.keys()][0] ?? '';
  }
  return pins;
}

/** Later than every migration the app has, so TypeORM runs it last. */
export function nextMigrationTimestamp(tree: Tree, src: string): number {
  const directory = tree.getDir(`${src}/migrations`);
  const latest = Math.max(
    0,
    ...directory.subfiles
      .map((file) => /^(\d{13})-/.exec(file)?.[1])
      .filter((stamp): stamp is string => stamp !== undefined)
      .map(Number),
  );
  return Math.max(Date.now(), latest + 1);
}
