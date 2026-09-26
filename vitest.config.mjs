// WITHOUT THE `@arthome/source` CONDITION, `verify` FAILS ON A FRESH CLONE, and the
//   error names the wrong file: Vitest resolves a workspace dependency through
//   `default`, which is `dist/index.js`, and says "Failed to resolve entry for package
//   @arthome-platform/messaging" — a manifest problem for a manifest that is fine.
//   Measured by hiding the four `libs/*/dist` trees. BOTH lists are needed:
//   `resolve.conditions` alone does not reach the Node (SSR) graph the tests run in.
//
// `*.itest.ts` is excluded so this suite needs no Docker daemon; integration tests
//   live behind `test:integration` in the packages that own them.
export default {
  resolve: {
    conditions: ['@arthome/source'],
  },
  ssr: {
    resolve: {
      conditions: ['@arthome/source'],
    },
  },
  test: {
    include: ['{apps,libs,tools}/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.itest.ts'],
  },
};
