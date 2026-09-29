import { noWallClock } from './no-wall-clock.mjs';

/** Bump `version` with any rule change: `eslint --cache` keys its results on it. */
export const arthomePlatform = {
  meta: { name: 'arthome-platform', version: '1.0.0' },
  rules: { 'no-wall-clock': noWallClock },
};
