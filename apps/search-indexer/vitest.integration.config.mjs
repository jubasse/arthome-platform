// The SLOW suite. Vitest has no `--include` flag, so widening the patterns needs a
// config — and this filename is deliberately not one Vitest discovers, so `pnpm run
// verify` keeps collecting only `*.spec.*`/`*.test.*` and never starts a container.
export default {
  // ⚠ READ THE WORKSPACE PACKAGES' SOURCES, NOT THEIR BUILDS. Otherwise Vitest resolves
  //   `@arthome-platform/testing` to `dist/index.js`, which is a staleness trap when it
  //   is built and a hard failure when it is not. The condition is the one
  //   @arthome/tooling's tsconfig already declares, so Vitest and tsc agree.
  resolve: {
    conditions: ['@arthome/source'],
  },
  // ⚠ The Node (SSR) graph has its own condition list: `resolve.conditions` alone leaves
  //   a workspace dependency on `default`.
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
