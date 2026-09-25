// The SLOW suite, and the reason it needs a file of its own.
//
// ⚠ VITEST HAS NO `--include` FLAG. It has `--exclude` and `--dir`, and neither
//   can widen the default patterns — so an alternative `include` can only be
//   given through a config, and a config Vitest finds by itself would be picked
//   up by the fast run too. Hence the name: `vitest.integration.config.mjs` is
//   not one of the names Vitest looks for (`vitest.config.{js,mjs,cjs,ts,…}`),
//   so it is read only when `--config` names it.
//
// ⚠ AND THE DEFAULT PATTERNS ARE EXACTLY WHAT THIS AVOIDS. `pnpm run verify`
//   ends in `vitest run`, which collects `*.spec.*` and `*.test.*` across the
//   repository. An integration test named either way would put a Docker daemon
//   and thirty seconds of container startup in front of every commit, and a gate
//   that costs that much stops being run — which costs far more than it saves.
//   `*.itest.ts` matches neither pattern, and that is the whole mechanism.
//
// No timeouts are set here. Container startup is slow, so the budget belongs in
// the test that starts the container, where the number can say what it is
// waiting for; a global timeout would also slacken the assertions that should
// fail fast.
export default {
  test: {
    include: ['src/**/*.itest.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
};
