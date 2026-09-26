// The slow suite. Vitest has no `--include` flag, so widening the default
// patterns needs a config — and a config Vitest finds by itself would be picked
// up by `pnpm run verify` too, putting a Docker daemon in front of every commit.
// Hence a name Vitest does not look for: it is read only when `--config` says so.
export default {
  test: {
    include: ['src/**/*.itest.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
};
