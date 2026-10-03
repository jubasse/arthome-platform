import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { noWallClock } from './no-wall-clock.mjs';

const ruleSourceHash = createHash('sha256')
  .update(readFileSync(new URL('./no-wall-clock.mjs', import.meta.url)))
  .digest('hex');

export const arthomePlatform = {
  meta: { name: 'arthome-platform', version: ruleSourceHash },
  rules: { 'no-wall-clock': noWallClock },
};
