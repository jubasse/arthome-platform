## Before you write anything

- **Name it first.** A function named for exactly what it does and a variable named for exactly
  what it holds remove the paragraph above them, and a long name is the cheap side of that
  trade — `waitUntilDue` needs no gloss, `handleRetryTiming` needs one. A comment is what is
  left when a name cannot carry it.

- **No systematic JSDoc.** Write it when the code is non-trivial or the reader needs context the
  signature cannot give; a one-line function whose name says what it does gets nothing, and a
  `@param` restating the parameter's name is noise. When warranted, **concise**.

- **Comment the why and the failure, never the what.** A comment earns its place by saying something
  the code cannot: a measured failure, a constraint that is not visible locally, a decision and its
  reason, a warning in words where the obvious change is the wrong one — never a `⚠`, an emoji or
  another pictographic symbol. Cut anything that restates the code or
  explains a well-named function. Past roughly a quarter of a file, the code is probably unclear
  rather than under-explained — measured here on 2026-09-25, three `libs/messaging` files stood at
  59 %, 55 % and 40 %. Never delete a recorded reason to satisfy a ratio: shorten the prose, keep
  the fact. **Shrink as you go** — any file you read or modify is one you may tighten, and that is the
  only way this reaches code written before the rule. Full text: `code-conventions.md` §5.10.

- **The domain is not defined here.** Entities, vocabularies, error codes and boundary DTOs come
  from `@arthome/core` and `@arthome/contracts`. A string literal that duplicates a vocabulary value
  is caught by `pnpm run check:enums`, and the fix is always the import, never the literal.
- **A library declares `@nestjs/*` and `typeorm` as peers, pinned to the apps' exact versions**
  (`nestjs-monorepo` rule 8), **without `injected`** in the apps: an injected copy stops an app
  reading the library's live source. So nothing but the pins keeps one copy of each installed, and
  no gate checks it yet: a bump that misses one library's pin makes a second `@nestjs/common`, and
  a `RefusalException` from that copy is no longer an `HttpException` to the error filter. Bump them
  everywhere at once, and check `node_modules/.pnpm` holds one version of each after install.
- **arthome-core arrives in one of two ways.** `pnpm run use-core <version>` installs a release: the
  manifests point at the tarballs attached to the GitHub release `v<version>` of arthome-core, and
  the lockfile pins their integrity. That is the state of `develop` and `main`, now on core 0.1.0 from
  its GitHub release. A checkout still on `file:` specs switches with `node tools/use-core.mjs 0.1.0`:
  pnpm 12 pre-installs before running a script and fails on the missing vendor tarballs. Later bumps
  can use `pnpm run use-core`.
  `pnpm run bootstrap` packs a sibling arthome-core checkout into `vendor/` and points the manifests
  at it with `file:` paths, for cross-repository work that is not released yet. Use it on a feature
  branch only: `pnpm run check:core-specs` refuses a `file:` spec on `develop` and `main`, and a pull
  request check runs it with `--require-release`, so run `use-core` before opening the PR.
  `vendor/` is build output: do not edit anything inside it.
- **After `pnpm run bootstrap`, restart your editor's ESLint server.** Bootstrap re-packs
  `@arthome/tooling`, so the shared ESLint configuration changes *inside `node_modules`* — and the
  extension only watches the root `eslint.config.js`, which did not move. The server keeps the flat
  config it loaded at startup and goes on reporting rules that no longer exist. In VS Code:
  **`ESLint: Restart ESLint Server`**.

  **When the editor and the CLI disagree, believe the CLI and check before editing code.** It
  recomputes everything on each run; the editor holds state. This has now bitten twice here for two
  different reasons — a stale ESLint server, and the editor resolving types through `dist` — and
  both times the code was already correct. One command settles it:
  `pnpm exec eslint <the exact file> --max-warnings 0`.

- **Install the hooks once, after cloning:** `git config core.hooksPath .githooks`. Git config is
  per-clone and is never carried by a checkout, so nothing installs them for you. `pre-commit`
  formats the staged files and then **refuses a commit whose `verify` is red** — which is the only
  thing that reliably stops the fault recorded in `code-conventions.md` §8.4, a shell line whose
  `;` discards verify's status. Without this one command the hook file sits inert and protects
  nobody.

- **Branches (arthome-core D-087).** Nothing is committed on `main` or `develop`. Work goes on
  `feature/{name}` from `develop`, one per repository it touches, and reaches `develop` through a
  pull request once `verify:full` is green — enforced by `.githooks/pre-push` on every push, since
  a PR always starts from one. A release is `release/{version}` from `develop`, merged into
  `main`, tagged `v{version}` and merged back, in the four repositories at once with one shared
  version. A worktree, an agent's included, branches from `develop`.

- **`pnpm run verify` is the gate.** Run it before every commit — and chain with `&&`, never `;`:
  this project has twice pushed with a red `verify` because a `;` let the commit run anyway.
  It is cached (ESLint, Prettier and `tsc` each skip what has not changed since the last run), which
  is fast enough to run on every commit but is not the full check — `pnpm run verify:full` is, every
  cache off, and it is what `.githooks/pre-push` runs before a push leaves the machine. See
  **Gates: three levels** below.

- **Walk [`docs/review-checklist.md`](../review-checklist.md) on your diff before handing over**;
  a reviewer walks it again. Each row is a defect reviews here found more than once, how to spot it
  and what prevents it.
  - **Enforced by `verify`**, through lint: `arthome-platform/no-wall-clock` refuses a time read
    outside the injected `Clock`, and every `eslint-disable` must name its rules and give its reason
    after `--` (`@eslint-community/eslint-comments`'s `no-unlimited-disable` and
    `require-description`). `@typescript-eslint/no-deprecated` refuses any use of a deprecated API,
    with no file exempted.
  - **Shared helpers, not run by `verify`, which only a reviewer enforces** (a helper prevents its
    defect only where it is used; `updateReturning` is in ticketing's payment inbox and messaging's
    `republishOutboxRow`, and `search-indexer`'s artist consumer still destructures its own):
    `updateReturning` (`@arthome-platform/transactions`) reads an UPDATE's or a DELETE's RETURNING rows, and
    `nextAttemptAt`, `retryDelayAfter`, `doublingDelays` and `attemptsAllowedBy`
    (`@arthome-platform/messaging`) are the one retry schedule, consumers and provider calls alike,
    the provider-call queues' backoff included.
  - **The local plugin's `meta.version` is the SHA-256 of the rule file, computed when the config
    loads**, never bumped by hand: `eslint --cache` keys its results on it, so editing a rule in
    `tools/eslint/` re-checks every file. A new rule file goes into the hash in
    `tools/eslint/plugin.mjs`.

**GitHub Actions are pinned by commit SHA**, with the version in a comment (`uses:
actions/checkout@<sha> # v7.0.1`). A tag can be moved to other code; a commit cannot. To bump an
action, resolve the new release's commit (`gh api repos/<owner>/<action>/commits/<tag> -q .sha`) and
update the SHA and the comment together. Python dependencies of the workflows are pinned by version.

