import type { Tree } from '@angular-devkit/schematics';

import { pascal } from '#schematics/names';
import { addImports, addToArrayProperty, renderImports } from '#schematics/source-file';
import { editText, type AppNames } from '#schematics/workspace';

export interface FeatureModule {
  readonly path: string;
  readonly className: string;
}

export interface FeatureModuleSpec {
  /** The file's name under `src/<module>/`, before `.module.ts`. */
  readonly file: string;
  readonly purpose: string;
  /** The root module that imports it: `app.module` or `consumer.module`. */
  readonly root: string;
  /** Whether its handlers take the app's `CLOCK`, bound here as in every feature module. */
  readonly clock: boolean;
}

/**
 * The feature module `src/<module>/<file>.module.ts`, created when absent with the app's
 *   transactions, and imported by its root module then.
 */
export function ensureFeatureModule(
  tree: Tree,
  names: AppNames,
  module: string,
  { file, purpose, root, clock }: FeatureModuleSpec,
): FeatureModule {
  const className = `${pascal(file)}Module`;
  const path = `${names.src}/${module}/${file}.module.ts`;
  if (tree.exists(path)) return { path, className };

  const imports = renderImports([
    { name: 'Module', from: '@nestjs/common' },
    ...(clock
      ? [
          { name: 'SystemClock', from: '@arthome/core' },
          { name: 'CLOCK', from: '../clock.js' },
        ]
      : []),
    { name: names.transactionsModule, from: `../${names.app}-transactions.js` },
  ]);
  const providers = clock
    ? '\n  providers: [{ provide: CLOCK, useValue: new SystemClock() }],'
    : '';
  tree.create(
    path,
    `${imports}

/** ${purpose} */
@Module({
  imports: [${names.transactionsModule}],${providers}
})
export class ${className} {}
`,
  );
  editText(tree, `${names.src}/${root}.ts`, (text) =>
    addImports(addToArrayProperty(text, { decorator: 'Module' }, 'imports', className), [
      { name: className, from: `./${module}/${file}.module.js` },
    ]),
  );
  return { path, className };
}

/** `className` from `from`, listed in the module's `providers` or `controllers`. */
export function register(
  tree: Tree,
  module: FeatureModule,
  list: 'providers' | 'controllers',
  className: string,
  from: string,
): void {
  editText(tree, module.path, (text) =>
    addImports(addToArrayProperty(text, { decorator: 'Module' }, list, className), [
      { name: className, from },
    ]),
  );
}
