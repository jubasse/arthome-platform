// The slow suite. Vitest has no `--include` flag, so widening the default
// patterns needs a config — and a config Vitest finds by itself would be picked
// up by `pnpm run verify` too, putting a Docker daemon in front of every commit.
// Hence a name Vitest does not look for: it is read only when `--config` says so.
export default {
  // READ THE WORKSPACE PACKAGES' SOURCES, NOT THEIR BUILDS. Otherwise Vitest resolves
  //   `@arthome-platform/messaging` to `dist/index.js`, which is a staleness trap when it
  //   is built and a hard failure when it is not. The condition is the one
  //   @arthome/tooling's tsconfig already declares, so Vitest and tsc agree.
  resolve: {
    conditions: ['@arthome/source'],
  },
  // The Node (SSR) graph has its own condition list: `resolve.conditions` alone leaves
  //   a workspace dependency on `default`.
  ssr: {
    resolve: {
      conditions: ['@arthome/source'],
    },
  },
  test: {
    // One Redis for the run, which `redis.itest.ts` reads through `inject`.
    globalSetup: ['./vitest.redis-setup.mjs'],
    include: ['src/**/*.itest.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
};
