// The slow suite, in a file of its own.
//
// Vitest has no `--include` flag — `--exclude` and `--dir` cannot widen the default
//   patterns — so an alternative `include` can only come from a config, and a config Vitest
//   finds by itself would be picked up by the fast run too. `vitest.integration.config.mjs`
//   is not one of the names Vitest looks for, so it is read only when `--config` names it.
//
// `pnpm run verify` ends in `vitest run`, which collects `*.spec.*` and `*.test.*`. An
//   integration test named either way would put a Docker daemon and thirty seconds of
//   container startup in front of every commit, and a gate that costs that much stops being
//   run. `*.itest.ts` matches neither pattern, and that is the whole mechanism.
export default {
  // Read the workspace packages' SOURCES, not their builds. Otherwise Vitest resolves
  //   `@arthome-platform/testing` through its `default` condition — `dist/index.js` — and
  //   fails when it has not been built. Building instead would install a staleness trap.
  //   `@arthome/source` is the condition @arthome/tooling's tsconfig already declares, so this
  //   makes Vitest agree with tsc rather than inventing a second resolution.
  resolve: {
    conditions: ['@arthome/source'],
  },
  // The Node (SSR) graph has its own condition list: setting `resolve.conditions` alone leaves
  // a workspace dependency resolved through `default`.
  ssr: {
    resolve: {
      conditions: ['@arthome/source'],
    },
  },
  test: {
    include: ['src/**/*.itest.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
};
