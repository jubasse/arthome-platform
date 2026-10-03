import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Rule, Tree } from '@angular-devkit/schematics';
import { format, resolveConfig } from 'prettier';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** Markdown is `.prettierignore`d here, and SQL has no parser. */
const FORMATTED = /\.(ts|mjs|json)$/;

function touchedPaths(tree: Tree): string[] {
  const paths = tree.actions
    .filter((action) => action.kind === 'c' || action.kind === 'o')
    .map((action) => action.path);
  return [...new Set(paths)].filter((path) => FORMATTED.test(path));
}

/**
 * Every file the run created or changed, laid out by the repository's own Prettier configuration,
 *   so `format:check` passes on what was generated and on the files it edited.
 */
export function formatTouchedFiles(): Rule {
  return async (tree: Tree) => {
    for (const path of touchedPaths(tree)) {
      const filepath = join(REPOSITORY_ROOT, path);
      const options = (await resolveConfig(filepath)) ?? {};
      const text = tree.readText(path);
      const formatted = await format(text, { ...options, filepath });
      if (formatted !== text) tree.overwrite(path, formatted);
    }
  };
}
