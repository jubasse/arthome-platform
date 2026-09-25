// The FAST suite, run by `pnpm run verify` — and the one line that lets it pass
// on a fresh clone.
//
// ⚠ WITHOUT THIS, `pnpm run verify` FAILS ON A CLEAN CHECKOUT. Vitest resolves a
//   workspace dependency through its `default` export condition, which is
//   `dist/index.js` — and a fresh clone has no `dist`. The failure is
//   "Failed to resolve entry for package @arthome-platform/messaging", which
//   names a manifest problem rather than a missing build, so it sends the reader
//   to the wrong file. Measured: hiding the four `libs/*/dist` trees turns verify
//   red with that error before a single test runs.
//
//   `@arthome/source` is the condition @arthome/tooling's tsconfig already
//   declares in `customConditions`, so this makes Vitest agree with tsc instead
//   of inventing a second resolution. BOTH lists are needed: `resolve.conditions`
//   alone does not reach the Node (SSR) graph the test files actually run in.
//
//   Building the libraries first would also work, and would install the
//   staleness trap the content-addressed vendor tarballs exist to prevent: a
//   change to a library would be invisible to the tests until somebody
//   remembered to rebuild.
//
// ⚠ `*.itest.ts` IS NOT COLLECTED HERE, and that is the whole mechanism keeping
//   this suite fast and Docker-free. Integration tests live behind
//   `test:integration` in the packages that own them. A gate that needed a Docker
//   daemon and half a minute would stop being run, and then stop being true.
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
