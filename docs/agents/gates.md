## Gates: three levels

Three different amounts of checking, for three different moments, so that the checking that must
never be skipped (before a PR) is never confused with the checking that only has to be honest about
what changed (the agent's own loop).

1. **The agent's working loop: affected only.** `pnpm run test:affected` is Vitest's own
   `--changed origin/develop` selection; `pnpm run test:integration:affected` is
   `pnpm --filter "...[origin/develop]" run test:integration`, dependents included through pnpm's
   dependency graph, not just the packages that changed. Both diff against `origin/develop`'s tip as
   last fetched — a stale ref only over-selects, which is safe, but `git fetch` first if it might be
   old. **Except**: a change of the arthome-core release or build (`vendor/`, or the `@arthome/*` specs), `libs/events`, `infra/`, any `.proto` file, or a root
   config (`package.json`, a `tsconfig*.json`, `eslint.config.js`, `vitest.config.mjs`,
   `pnpm-workspace.yaml`) — run the full `pnpm run test` and `pnpm run test:integration` instead.
   `vendor/` is gitignored, so a filter based on `git diff` never sees a local tarball change at all;
   `libs/events` and a proto both name the wire contract every service and consumer reads; `infra/`
   feeds the integration stack (`libs/testing/src/stack.ts`'s Debezium and topic config) from outside
   every workspace package, so a package-based filter cannot select it; and a root config changes
   what every package's build, lint or test does, not one package's own dependency graph.

2. **The commit hook: full `verify`, cached — or the docs path.** ESLint, Prettier and `tsc` each
   check the same files `verify` has always checked, each keeping a cache under an ignored
   `node_modules/.cache/` (ESLint `--cache --cache-strategy content`, Prettier `--cache
   --cache-strategy content`, `tsc --incremental`). **The ESLint cache has a real gap**: the shared
   config is type-aware (`no-floating-promises`, `import-x/no-cycle` and others), so a file's result
   can depend on another file that changed while the file itself did not — its cached "clean" result
   is then stale, and a warm hook commits a cross-file lint error the same code would fail cold. The
   pre-push hook below is what closes that gap, not this one. When every staged file matches `*.md`
   — checked over `git diff --cached --name-only --no-renames`, with no `--diff-filter`, so a deleted
   or renamed non-`.md` path still counts as "not docs" — `.githooks/pre-commit` instead runs only
   `check:symbols` and `check:language`, the two `verify:offline` checks that read prose; both scan
   every tracked file already, so this only skips what a documentation-only change cannot move.

3. **Before the branch leaves the machine: `pnpm run verify:full`.** `.githooks/pre-push` runs it and
   refuses the push when it is red. Every cache is off (no `--cache`, no `--incremental`), so this is
   what actually re-lints, re-typechecks and re-tests everything, closing the cached lint gap above,
   since every commit that reaches `develop` goes through a pushed branch and a PR. After a merge,
   the full `verify` and `test:integration` run again on a clean checkout.

   **A push that only deletes refs skips it.** `pre-push` reads `<local ref> <local sha> <remote ref>
   <remote sha>` per line on stdin; a deletion's local sha is all zeros and the push carries no
   commit, so when at least one line was read and every line is one the hook exits 0 at once. An empty
   stdin fails closed and runs `verify:full`. A push that creates or updates any ref
   alongside a deletion still runs `verify:full`. Proven against a local bare remote, never origin:
   a branch creation ran `verify:full` (67 s), a deletion alone took under a second, and a push of
   one new branch with another's deletion ran it again (75 s).

Measured 2026-09-29, develop at 89c8a25, on a shared machine whose load varied with other agents
running at the same time: `verify:full` about 109 s; `verify` cold (empty caches, right after
`bootstrap`) about 110–140 s; `verify` warm, nothing changed, about 25–55 s; `verify` warm after a
one-line change in one file, roughly 20–30 s above the warm-unchanged run, almost all of it the
touched project's `tsc` re-check; a docs-only commit through the hook, under 1 s. A deliberate type
error, lint error and failing test, tried one at a time against the cached commit hook, were each
still caught, then reverted; a cross-file type-aware lint error and a staged deletion, tried against
the cached commit hook, were each missed as designed and then caught by `pre-push`'s `verify:full`.

**Lint does not depend on `libs/*/dist`.** `eslint.config.js` gives `import-x/order` a pathGroup
that sorts `@arthome-platform/**` with the external packages, so the verdict is the same in a fresh
worktree and after `build:libs`. Before, a workspace import was internal with a `dist/` and external
without, and `tools/ops-check.mjs` and `tools/republish-outbox.mjs` flipped. Keep workspace imports
in alphabetical order among the external ones.

