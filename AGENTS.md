# Working in arthome-platform

## Read these first, in this order

They are in `docs/arthome/`, copied out of `@arthome/tooling` on every install and committed here.
**They are a projection: edit the originals in arthome-core, never these copies** — an install
overwrites them without warning.

1. **[`docs/arthome/critical-rules.md`](docs/arthome/critical-rules.md)** — nineteen lines. Re-read
   every session. Not a summary of the conventions; the things that have actually gone wrong.
2. **[`docs/arthome/code-conventions.md`](docs/arthome/code-conventions.md)** — how the code is
   written here, and why each rule exists.
3. **[`docs/arthome/available-surface.md`](docs/arthome/available-surface.md)** — what
   `@arthome/core` and `@arthome/contracts` already export, and what each subpath is for.
   **Read it before writing a helper.** On the day the contracts were written, ten modules
   independently wrote the same `instant()` and four wrote the same local-vocabulary helper. None of
   their authors was careless — nothing told them the export existed. This file is that telling.

## Required NestJS skills

This project uses the jubasse/agent-skills NestJS skills (NestJS 12). **Before writing, reviewing or
debugging NestJS code, load `nestjs-how-to` and the skills it routes to.** Always relevant here:

- `nestjs-architecture`, `nestjs-request-pipeline`, `nestjs-validation`, `nestjs-config`,
  `nestjs-testing`, `nestjs-http`
- `nestjs-typeorm` (typeorm, @nestjs/typeorm) · `nestjs-kafka` (kafkajs) · `nestjs-event-driven`
  (the outbox and the idempotent consumers) · `nestjs-performance` (@nestjs/platform-fastify) ·
  `nestjs-monorepo` (pnpm workspace) · `nestjs-search` (@opensearch-project/opensearch) ·
  `nestjs-bff-gateway` (`apps/bff-storefront`) · `nestjs-cqrs` (@nestjs/cqrs, `apps/catalog`,
  `apps/ticketing`, `libs/transactions`, `libs/testing`'s `httpApp` and
  `@arthome-platform/messaging/nest`'s `ConsumerHostModule`, whose conventions are
  `apps/catalog/HANDOVER.md` §0f) ·
  `nestjs-ddd` (catalog's aggregates and repository ports, which `nestjs-cqrs` routes to)

Project decisions — the ADRs and `DECISIONS.md` in arthome-core — take precedence over these
community defaults, and a recorded decision is never reopened.

**THIS BLOCK EXISTS BECAUSE THE SKILLS WERE NOT LOADED.** `identity`, `notifications` and
`catalog` were all written without them; only `nestjs-event-driven` was opened, and late, at which
point it corrected two real defects that were already in the code — no jitter on retries, and no
guard against a retry topic reordering one aggregate's events. The rule the router states is
`MUST load skills before writing NestJS code`, and v12 changed ESM, Express 5, validation and the
error model. Skills trigger on their descriptions, and an agent that believes it already knows
NestJS skips them; this block is what makes loading systematic rather than remembered.

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
- **`vendor/` is build output of another repository.** Do not edit anything inside it. To pick up a
  change made in arthome-core, run `pnpm run bootstrap`.
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
  pull request once `verify` is green. A release is `release/{version}` from `develop`, merged into
  `main`, tagged `v{version}` and merged back, in the four repositories at once with one shared
  version. A worktree, an agent's included, branches from `develop`.

- **`pnpm run verify` is the gate.** Run it before every commit — and chain with `&&`, never `;`:
  this project has twice pushed with a red `verify` because a `;` let the commit run anyway.
  It is cached (ESLint, Prettier and `tsc` each skip what has not changed since the last run);
  `pnpm run verify:full` is the same gate with every cache off, and is what a PR needs green. See
  **Gates: three levels** below.

- **Walk [`docs/review-checklist.md`](docs/review-checklist.md) on your diff before handing over**;
  a reviewer walks it again. Each row is a defect reviews here found more than once, how to spot it
  and what prevents it.
  - **Enforced by `verify`**, through lint: `arthome-platform/no-wall-clock` refuses a time read
    outside the injected `Clock`, and every `eslint-disable` must name its rules and give its reason
    after `--` (`@eslint-community/eslint-comments`'s `no-unlimited-disable` and
    `require-description`).
  - **Shared helpers, not run by `verify`, which only a reviewer enforces** (a helper prevents its
    defect only where it is used; `updateReturning` is in ticketing's payment inbox and messaging's
    `republishOutboxRow`, and `search-indexer`'s artist consumer still destructures its own):
    `updateReturning` (`@arthome-platform/transactions`) reads an UPDATE's or a DELETE's RETURNING rows, and
    `nextAttemptAt`, `doublingDelays` and `attemptsAllowedBy` (`@arthome-platform/messaging`) are
    the one retry schedule, consumers and provider calls alike.
  - **The local plugin's `meta.version` is the SHA-256 of the rule file, computed when the config
    loads**, never bumped by hand: `eslint --cache` keys its results on it, so editing a rule in
    `tools/eslint/` re-checks every file. A new rule file goes into the hash in
    `tools/eslint/plugin.mjs`.

## The commands

| command | what it does |
| --- | --- |
| `pnpm run bootstrap` | packs the sibling arthome-core into `vendor/`, installs, then builds every lib (`build:libs`) |
| `pnpm run build:libs` | `tsc -p tsconfig.build.json` in every `libs/*`; also what makes their `dist/` exist for ESLint's `import-x/order` (see below) |
| `pnpm run verify` | everything below, in order, stopping at the first failure — cached |
| `pnpm run verify:full` | the same, every cache off; the gate before a PR |
| `pnpm run verify:offline` | the subset needing no install — vendor, versions, tsconfig, enums, language, symbols |
| `pnpm run check:enums` | string literals that duplicate a domain vocabulary |
| `pnpm run fix` | Prettier, then ESLint `--fix`, then Prettier again |
| `pnpm run test:affected` | Vitest limited to what changed against `origin/develop` — the agent's working loop, not the gate |
| `pnpm run test:integration` | the container suites (`*.itest.ts`) that `verify` skips; needs Docker. Run it after touching a consumer, the outbox or `libs/testing` |
| `pnpm run test:integration:affected` | the same suites, limited to packages changed against `origin/develop` and their dependents |
| `pnpm run purge:retention <service>` | what the retention job would delete; `--apply` to do it |
| `pnpm run ops:check <service>` | the operational checks; exits 1 when anything is degraded |
| `pnpm run republish:outbox <service>` | outbox rows never published to their topic; `--apply` republishes them |

## Gates: three levels

Three different amounts of checking, for three different moments, so that the checking that must
never be skipped (before a PR) is never confused with the checking that only has to be honest about
what changed (the agent's own loop).

1. **The agent's working loop: affected only.** `pnpm run test:affected` is Vitest's own
   `--changed origin/develop` selection; `pnpm run test:integration:affected` is
   `pnpm --filter "...[origin/develop]" run test:integration`, dependents included through pnpm's
   dependency graph, not just the packages that changed. **Except**: a change under `vendor/`,
   `libs/events`, or any `.proto` file — run the full `pnpm run test` and `pnpm run test:integration`
   instead. `vendor/` is gitignored, so a filter based on `git diff` never sees a tarball change at
   all; and `libs/events` and a proto both name the wire contract every service and consumer reads,
   whose blast radius is not the dependency graph pnpm can trace from one package's source.

2. **The commit hook: full `verify`, cached — or the docs path.** ESLint, Prettier and `tsc` each
   check the same files `verify` has always checked; each now keeps a cache under an ignored
   `node_modules/.cache/` (ESLint `--cache --cache-strategy content`, Prettier `--cache
   --cache-strategy content`, `tsc --incremental`), so an unchanged file is not re-examined, never
   a narrower check. When every staged file matches `*.md`, `.githooks/pre-commit` instead runs only
   `check:symbols` and `check:language` — the two `verify:offline` checks that read prose — because
   nothing else in `verify` can be affected by a documentation-only change; both already scan every
   tracked file, so this is a skip of what cannot move, not a smaller version of what remains.

3. **Before a PR: `pnpm run verify:full`.** The same gate, every cache off (no `--cache`, no
   `--incremental`) — the full, uncached check the cached hook only approximates run to run. After a
   merge, the full `verify` and `test:integration` run again on a clean checkout.

Measured 2026-09-29, develop at 89c8a25, on a shared machine whose load varied with other agents
running at the same time: `verify:full` about 109 s; `verify` cold (empty caches, right after
`bootstrap`) about 110–140 s; `verify` warm, nothing changed, about 25–55 s; `verify` warm after a
one-line change in one file, roughly 20–30 s above the warm-unchanged run, almost all of it the
touched project's `tsc` re-check; a docs-only commit through the hook, under 1 s. A deliberate type
error, lint error and failing test, tried one at a time against the cached hook, were each still
caught, then reverted.

**Why `bootstrap` builds the libs.** In a fresh worktree, right after `bootstrap` used to stop at
`pnpm install`, `verify` failed lint on `tools/ops-check.mjs` and `tools/republish-outbox.mjs`:
ESLint's `import-x/order` could not resolve `@arthome-platform/config` and `@arthome-platform/messaging`
through their `exports` map's `default` condition, which points at `dist/`, absent until a lib is
built — so it fell out of the `internal` group the rule expects and read as an `external` import out
of order. Not a rule to special-case: `pnpm run build:libs`, now inside `bootstrap`, makes `dist/`
exist before anything lints, which is what every other consumer of these libs already needed anyway.

## Running the event path

The event path is three containers: Postgres 18 with `wal_level=logical`, Kafka in KRaft mode, and
Kafka Connect carrying Debezium. OpenSearch serves the search, and Redis 8.8 waits for ticketing's
queues and waiting room, with no eviction and an append-only file (`nestjs-queues` rule 6); nothing
reads it yet. **Postgres publishes on 55432, not 5432, and Redis on 56379, not 6379** — the
conventional port was taken by another project, and a development stack that fights for well-known
ports is one you cannot run beside anything else.

```bash
docker compose up -d
export NODE_ENV=development       # required, and never defaulted — see below
pnpm --filter @arthome-platform/identity      run migration:run
pnpm --filter @arthome-platform/notifications run migration:run
pnpm --filter @arthome-platform/catalog       run migration:run
pnpm --filter @arthome-platform/search-indexer run migration:run
pnpm --filter @arthome-platform/ticketing     run migration:run   # its three processes stopped first
pnpm run provision:topics          # BEFORE the connectors, and before any consumer
for c in identity catalog ticketing; do
  curl -s -X POST -H 'Content-Type: application/json' \
    --data @infra/debezium/$c-outbox.json http://localhost:8083/connectors
done
```

**`NODE_ENV` is required and deliberately has no default**, which is why it is exported before
anything else here. Every other variable a service reads — `DATABASE_URL`, `KAFKA_BROKERS`, `PUBLIC_WEB_ORIGIN`,
`OPENSEARCH_URL`, `REDIS_URL`, `PAYMENT_WEBHOOK_SECRET` — is filled from a local default **only outside production**, and `NODE_ENV` is
what selects that. Defaulting it to `development` would make an unset variable open the
production-guarded write routes and point a migration at localhost; both fail loudly instead, naming
the variable. `PORT` is the single exception and defaults to 3000: the migration CLI never listens,
and a wrong port fails at bind where a wrong `DATABASE_URL` connects somewhere else in silence.

No service reads `process.env` any more. `libs/config` parses once, at module load, with the
protocol asserted — `postgres:` for the database, `http:`/`https:` for the index, `redis:`/`rediss:`
for Redis — because a bare URL check accepts `localhost:29092` as a URL whose scheme is
`localhost:`.

**`/health/liveness` AND `/health/readiness` ARE SPLIT, AND ONLY THE DATABASE FAILS READINESS.**
Liveness touches no dependency: a failing one restarts the pod, and a database outage must not restart
every replica at once. Readiness answers 503 only when the database is unreachable. The replication
slot, the publication's scope and the outbox retention answer `degraded` — a 200 with the detail in
the body — because a stopped connector must delay publishing, not take the API out of rotation.
Proven on the running stack: with `connect` stopped, readiness stays 200 and a registration still
answers 201. Both routes are exempt from `DenyInProductionGuard`; nothing else is.

The two consumers serve no HTTP, so their checks — dead-letter depth and `processed_message`
retention — run through `pnpm run ops:check`, as does the publishers' `unpublished_outbox`, which
reads whole topics and so stays off readiness. The first run found a message sitting in
`arthome.notifications.dlq` that nothing had ever reported.

**THE RETENTION JOB IS A COMMAND, NOT A SCHEDULE.** `data-model.md` §7.5 owes `outbox_event` a
7-day purge and `processed_message` a horizon; neither existed. `libs/messaging` now has
`purgeOutbox` and `purgeProcessedMessages`, and `pnpm run purge:retention <service>` runs them.
There is no job runner here, so nothing calls it on a timer — that is a deployment concern, and it
is visible rather than missing.

  **The outbox purge is gated on the connector, not on the clock.** It reads the slot's
  `confirmed_flush_lsn` and refuses when the slot is inactive or lagging past §7.4's own
  one-gigabyte alert threshold, because deleting a row Debezium has not read destroys a committed
  fact that was never published and nothing reads that table back to notice. Proven both ways on
  the running stack: it purges with the connector up, and answers `REFUSED` with it stopped.

  **`processed_message`'s 30 days must stay above every topic's retention.** Past that a message
  cannot come back at all; below it, a replay, off the dead-letter topic or through a rewound group,
  finds no row and the effect applies twice in silence. Every topic's retention is declared in `infra/kafka/topics.json` (168 h) and applied by
  `provision:topics`, and `topic-retention.spec.ts` fails the day one would outlive the ledger.

**`migration:generate` OUTPUT IS NOT TRUSTWORTHY ON `outbox_event`, AND THE DAMAGE IT PROPOSES IS
REAL.** Run against a migrated identity or catalog database it emits a migration that DROPS and
re-adds all four outbox CHECK constraints with identical definitions — `payload_not_empty`,
`type_is_versioned`, `aggregateid_present`, `aggregatetype_is_topic_safe`. They live as SQL strings in
`libs/messaging/src/outbox.ts` and are applied by each service's migration; the entity does not
declare them, so the generator treats them as drift. Each `ALTER TABLE … ADD CONSTRAINT` takes ACCESS
EXCLUSIVE and scans the whole table — on the table every write inserts into.

  Verified 2026-09-25 against the running stack. **Read anything `migration:generate` emits before
  keeping it**, and delete the constraint churn. Declaring the checks on the entity would silence it
  and would put the expressions in two places, which is the fault class this repository spends its
  gates preventing — so the generator stays untrustworthy here by choice, and this note is the
  mitigation.

**NEVER DROP A PUBLICATION UNDER A LIVE SLOT, AND DELETING A CONNECTOR DOES NOT CLEAR ITS
OFFSETS.** Both learned the hard way on 2026-09-26, and together they lose events.

  The publication had been created `FOR ALL TABLES` by a connector registered before
  `publication.autocreate.mode: filtered` was added to the file — the fix was on disk and had never
  been re-posted, and **a publication is not corrected by changing the config**. Dropping it while
  the slot still held a position failed the task with
  `Message with LSN '…' not present among LSNs seen in the location phase`.

  Recovering by dropping the slot too then loses whatever was written between the stored offset and
  the new slot's start: Kafka Connect keeps a deleted connector's offsets under its name, so the
  connector resumes at an LSN whose WAL the new slot never covered, and the log says
  `no snapshot will be executed`. **The row stays in `outbox_event`, unpublished, and nothing reads
  that table back to notice** — the §7.5 hazard arriving from the other direction, found and put back
  by `republish:outbox` below.

  So: to change a publication, delete the connector, drop the publication, **and** drop the slot,
  then verify `pg_publication_tables` returns exactly one row before producing anything you care
  about. Do it on an empty outbox.

**A row committed but never published is found and put back by command.** `ops:check` on a
publisher reports `unpublished_outbox`: the rows whose id appears in no `message-id` header on their
topic, older than five minutes (in flight otherwise) and younger than six days (inside the topics'
seven-day retention). Slot positions cannot find them: the slot never saw the row.
`pnpm run republish:outbox <service>` lists them, and `--apply` deletes and reinserts each row in one
transaction, id included. The router routes inserts and drops the delete without a tombstone, so the
fact goes out again under its original `message-id` and every consumer's ledger absorbs a second
copy. Proven on the running stack on 2026-09-26: a show written with the connector stopped and the
slot advanced past it was reported, republished and indexed at its original `occurred_at`;
republished again, the indexer answered `duplicate`.

**`provision:topics` is not a convenience.** A topic auto-created by the first producer takes the
broker's default partition count — **one** — while `events.md` §3 fixes 3 or 12 depending on the
topic. Those numbers are the headroom that lets replicas be added without repartitioning, and
partitions cannot be reduced afterwards while raising them re-hashes every key, breaking the
per-aggregate ordering the key exists to guarantee. Measured on a fresh stack: the connector
auto-created `arthome.identity.account` with 1 partition, and the gate refused to silently
"fix" it. It is also what a consumer needs to start at all — KafkaJS will not subscribe to a topic
that does not exist (`This server does not host this topic-partition`).

Then start `identity` (port 3001) and `notifications`, and register an account:

```bash
curl -X POST http://localhost:3001/accounts \
  -H 'content-type: application/json' \
  -H 'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' \
  -d '{"publicHandle":"@marie.j","email":"marie@example.test","locale":"fr","country":"FR"}'
```

What should then be true, and what is worth checking because each step can fail quietly:

| Where | What you should see |
| --- | --- |
| `identity.outbox_event` | one row, `aggregatetype = identity.account`, `aggregateid` = the account id |
| topic `arthome.identity.account` | one message, **key = the account id**, so one account stays ordered |
| its headers | all five: `message-id`, `type`, `traceparent`, `actor-id`, `occurred-at` — the traceparent being the one the request carried. Debezium renders a NULL column as the four characters `null`, not as an absent header |
| `notifications.welcome_email` | one row, holding that same traceparent |
| replaying the message | the consumer says `duplicate` and the row count does **not** move |

### The catalog date path

`catalog` runs two processes from `apps/catalog`: the API (`node dist/main.js`, on `PORT`) and the
checklist consumer (`node dist/consumer.js`). A date goes from draft to published through the
studio's commands, each carrying an `Idempotency-Key`:

```
POST /venues                                  → venueId
POST /shows   (with title, synopsis, poster)  → showId
POST /channels/:channelId/dates               → 201, the date sheet, its publication in draft
POST /dates/:dateId/publication/transitions   { to, expectedVersion, acknowledgedPromiseCode }
POST /v1/dates/:dateId/outcome                { outcome, message, rescheduledTo, expectedVersion }
PATCH /v1/channels/:channelId/identity        { expectedVersion, publicName, slug, biography, categoryId }
```

Publishing answers `publication.checklist_incomplete` until ticketing, streaming and chat have
reported their four facts. None of those services exists yet, so in development send the facts by
hand on `arthome.ticketing.date_sales`, `arthome.streaming.run` and `arthome.chat.date`, keyed by the
date id, with a `message-id` and a `type` header.

Proven on the running stack on 2026-09-26:

| Check | Result |
| --- | --- |
| a replayed draft | `Idempotency-Replayed: true`, the body byte for byte, first `servedAt` included |
| the same key with another body | 409 `api.idempotency_key_reused` |
| a stale `expectedVersion` | 409 `state.conflict`, with the current state and version |
| publishing before the facts | 409 `publication.checklist_incomplete`, the four projected items named |
| publishing after them | on `arthome.catalog.date`, one partition, in order: `drafted`, two state changes, `date.scheduled` with the venue clock and canonical URL, `publication.engaged` |
| `search-indexer` running beside them | the date indexed in `arthome-catalog-date` with its show's titles and taxonomy and its venue's city; `nuit` finds `Les Nuits d’été` filtered on `marseille`; a show update and a move to `technical` each recompose it (version 1, 2, 3); a backlog from before the proto change indexed without errors |

The same run found two defects, both fixed and now held by tests: a draft served `…/d/undefined` as
its canonical URL, and a replay came back with its keys reordered, because `jsonb` reorders them.

An outcome was proven on the same stack on 2026-09-27, the indexer, catalog and the BFF running:

| Check | Result |
| --- | --- |
| postponing a published date to 15 December | 200; replayed under its key with `Idempotency-Replayed: true`; `outcome_declared` then `rescheduled` on the date's topic |
| its page through the BFF | `postponed` until 18:30 on 15 December, the new `startsAt` and `rescheduledTo` |
| the index and the search | the document moved to the new time with `outcome: postponed`; the show's group led by it |
| cancelling the other date | its page `cancelled` with no `displayStateValidUntil`, the index following |
| a second outcome; a draft; `postponed` without `rescheduledTo` | 409 naming `outcome`; 409 naming `state`; 400 naming `rescheduledTo` |
| the BFF giving up on a frozen index | 504 in 208 ms, and catalog still up |

That last row is a defect the run found: catalog crashed on the first abort, because its listener
returned the OpenSearch request, a thenable, and Node's `EventTarget` reports a listener's rejected
thenable as an uncaught exception. Fixed, and held by `search-catalog.handler.spec.ts`.

A channel's public face was proven the same way on 2026-09-27:

| Check | Result |
| --- | --- |
| creating it from version 0 | version 1 at the envelope's root, the slug from the name; replayed under its key |
| the channel's date pages, the index, a search for the artist's name | the artist named on the card at once; `artist_name` in the document once the indexer read `ArtistUpdated`; `q=port` finds the show (the first call after the start answered no groups, its body not captured) |
| the artist page through the BFF | 12 ms; the biography, the postponed date among the upcoming, the cancelled one among the past |
| `/fr/a/compagnie-du-port` resolved | the artist, its canonical URL |
| its slug from another channel; a stale edit | 409 `artist.slug_taken`; 409 `state.conflict` with the version |

The per-language URLs of the tables above were replaced the same day by arthome-core D-075 (no
language, `/show/…/date/…`, `/artist/…`, short `/s/` and `/a/`), and a date may now be postponed
three times (D-076). Proven on the stack above on 2026-09-27, `search-indexer` migrated before
catalog, the three processes running:

| Check | Result |
| --- | --- |
| the two migrations | show and date slugs backfilled (`nuits-blanches-a-marseille`, `2026-12-15`, `2026-12-19`); one `DateScheduled` restated per published date; the index documents rewritten with `show_slug`, `slug` and the new URL, nothing replayed by hand |
| search, the date page, `/show/…/date/…`, `/s/…`, `kind=date&slug={show}/{date}`, `/a/…` through the BFF | the new slug and canonical URL on the card and the page; each form resolved to its page, 10 to 15 ms |
| an old `/fr/d/…` URL | 404: never served outside development, not carried over |
| a second postponement | 200; the slug moved to `2026-12-22`, the old one aliased until 27 October and still resolving to the new URL; the index following |
| a third, a fourth, then a cancellation | 200; 409 `date.postponement_limit_reached` with `max: 3`; 200, the page `cancelled` at its last date |
| postponing the cancelled date | 409 `state.conflict` naming `outcome` |
| the artist's slug changed | the old `/a/…` resolving to `/artist/port`; the old slug refused to another channel, 409 `artist.slug_taken` |

Catalog moved to `@nestjs/cqrs` the same day (arthome-core D-084, D-085; the conventions are
`apps/catalog/HANDOVER.md` §0f). Proven on the stack above, the API, the checklist consumer, the
indexer and the BFF all built from that code, the facts sent on the three source topics by a
producer script:

| Check | Result |
| --- | --- |
| a draft, then the same key again | 201; replayed 201 with `Idempotency-Replayed: true` |
| the four checklist facts through Kafka | `applied` four times; the same `message-id` again, `duplicate` |
| facts about a date catalog does not hold | `dead-lettered` at once: attempt 0, reason `permanent`, "… is about date …, unknown here" |
| a `message-id` that is not a UUID | retried as transient on `arthome.catalog.retry`, since `processed_message.id` refuses it. Fixed since: `messageIdOf` in `libs/messaging` refuses it at every consumer's edge, dead-lettered at attempt 0, reason `permanent` |
| publishing | 200, version 2; slug `2027-03-10`, running time frozen at 110; on the date's key `drafted`, `state_changed`, `date.scheduled`, `engaged`; indexed; resolved through the BFF in 57 ms |
| postponing, then a stale command | 200, slug `2027-03-17`, the old one aliased; `outcome_declared` then `rescheduled`; 409 `state.conflict` with version 3 |
| the show retitled, the artist renamed | the old URL resolves to the new one, with the new title and the new name |
| SIGTERM to the consumer | both groups stopped, exit in 2.2 s, no connection left in `pg_stat_activity` |

The `TimeoutNegativeWarning` a KafkaJS client prints at start comes from KafkaJS 2.2.4 on Node 24:
a bare producer script prints it too.

### The ticketing date sales path

`ticketing` runs three processes from `apps/ticketing`, all on its own database `ticketing`: the API
(`node dist/main.js`, `PORT=3004` in `.env.example`), the catalog consumer (`node dist/consumer.js`)
and the sweeper (`node dist/sweeper.js`), which publishes `availability_changed`, expires the holds
nobody paid, closes each sale thirty minutes after its start (D-089, HANDOVER §0l), and needs
Postgres alone. Its connector is `infra/debezium/ticketing-outbox.json`, registered with the loop above.

A date catalog drafts is opened in ticketing by the consumer; the studio then gives it capacity and
prices, each with an `Idempotency-Key` and the version the pane served:

```
POST /v1/dates/:dateId/capacity-tiers   { additionalCapacity, expectedVersion, notifyWaitlist }
PUT  /v1/dates/:dateId/prices           { expectedVersion, tiers: [{ tier, amountMinor, currencyCode, active }] }
PUT  /v1/dates/:dateId/technical-provision  { provisionedCapacity, expectedVersion }; past core's TECHNICAL_PROVISION_THRESHOLD
GET  /v1/dates/:dateId/panes/tickets
GET  /v1/dates/:dateId/availability     x-arthome-deadline required; 404 unless on sale
```

Each command writes `capacity_set` or `pricing_changed` on `arthome.ticketing.date_sales`, keyed by
the date, which catalog's checklist consumer reads: with them, catalog's by-hand
`arthome.ticketing.date_sales` facts above are no longer needed. Publishing the date in catalog
locks the prices in ticketing (`date.prices_locked` from then) and opens the sale; the sweeper then
publishes the availability at most every five seconds per date, a sell-out at once. What each part
does and why is `apps/ticketing/HANDOVER.md`.

**Deploy ticketing's consumer before the first date is drafted in production.** It opens a sale only
from `catalog.date.drafted`, and reads `arthome.catalog.date` from the beginning of what the topic
keeps: a date drafted more than the topic's retention (168 h) before the group first reads it never
opens, and every later fact about it is retried, then dead-lettered.

Proven on the running stack on 2026-09-27, the ticketing database created by hand (the init script
runs only on an empty data directory), its migration run, its connector registered, the four new
topics provisioned, catalog's API and consumer and ticketing's three processes running:

| Check | Result |
| --- | --- |
| a date drafted in catalog | opened in ticketing within 5 s through Debezium: version 1, no capacity, no price; the backlog of `arthome.catalog.date` opened the dates already drafted |
| `openCapacityTier` 300, then `setDatePrices` full 2500 and reduced 1800 EUR | 200, versions 2 and 3; a write naming version 2 again, 409 `state.conflict` with version 3 |
| catalog's checklist | `capacity` and `at_least_one_active_price` satisfied by ticketing's own events, no fact sent by hand |
| publishing in catalog | ticketing locked the prices and opened the sale: 300 seats; `setDatePrices` then 409 `date.prices_locked` with `lockedAt` |
| the public availability | 200 with `validUntil` 60 s out; without `x-arthome-deadline`, 400 |
| ticketing's outbox for the date | `capacity_set`, `pricing_changed`, `pricing_changed` (the lock), then `availability_changed` from the sweeper half a second after the sale opened |

That run was at 630dbd5, before the reviews' fixes. Proven again at e0967b4, after them and after
core's rules and D-088, the three new migrations run on the database that already held those dates:

| Check | Result |
| --- | --- |
| a tier past 10,000 with no provision | 409 `date.technical_provision_required`, naming the threshold, the capacity and `revisableUntil` |
| `setTechnicalProvision` 12,000, then a tier to 12,000 | 200 and 200; both wrote a `capacity_set`, and the sweeper published the new availability 0.4 s later |
| a provision of 11,000 under 12,000 open | 409 `date.provision_below_capacity` |
| prices in EUR and CHF on a fresh draft | 409 `date.prices_currency_mismatch`, naming the tier and both currencies |
| the date cancelled in catalog | the sale closed in ticketing: the availability read 404, a new tier 409 `state.conflict` naming the outcome, and a last `availability_changed` of 0 seats, `sold_out` false, 0.7 s after the cancellation |

Proven a third time on 2026-09-27 at 70307cb, after the re-review's fixes, their migration `1790440400000` run
on the database that already held those dates. The unpublishable date is a hand edit, the same one
the container suite makes: no validated write stores such a price.

| Check | Result |
| --- | --- |
| two tiers on a date on sale, one second apart | the first published 0.9 s after it, the second 5.2 s after the first publication, as the interval holds it |
| a date whose price core refuses (`amountMinor` 1.5), moved | `money.amount_not_integer` logged, `failed_at` set; tried again every 10.1 s; a tier opened meanwhile on another date published in the same pass |
| that price put back | published at the next retry, `failed_at` cleared |
| a date on sale cancelled in catalog | the sale closed in ticketing 0.3 s after catalog's answer; its closing, no longer on sale, reached through `closing_due` and published once 1.6 s later: 0 seats, `sold_out` false; the availability read 404 |

### The ticketing purchase path

The storefront's seat operations run on ticketing's API, the BFF routes being T7's; the payment
provider is the fake adapter, bound by default (`adr-payments.md` §4), which confirms every intent
at once on the running stack:

```
POST /v1/dates/:dateId/seat-quote   { tier, quantity }                 x-arthome-deadline required
POST /v1/orders/seats               { dateId, tier, quantity, expectedTotal }   Idempotency-Key required,
                                                    X-Arthome-Late-Entry-Acknowledged after the start
GET  /v1/orders/:orderId                                                x-arthome-deadline required
```

`purchaseSeat` answers 201 with the tickets and the order once paid, 202 with the payment handoff
while the buyer has to act, 409 `order.sold_out`, `order.price_stale` or `order.payment_declined`,
and 503 when the provider does not answer; a replay under its key answers the first answer again.
Seats sell until thirty minutes after the live's start (D-089): from the start the quote carries
`lateEntry`, and a purchase without `X-Arthome-Late-Entry-Acknowledged: true` is refused 409
`order.late_entry_unacknowledged` before any seat is taken, a retry under its key included; past the
cutoff, the quote and the purchase answer 409 `order.sales_closed`.
The provider's webhooks arrive on `POST /v1/payments/webhook`, verified on their raw bytes, recorded
in `stripe_event_inbox` and answered at once; the API process's payment worker applies them every
second, refunds at once a payment confirmed after its hold expired with no seat left (D-082), and
cancels the intents of expired orders (`apps/ticketing/HANDOVER.md` §0j, §0k).

The capacity invariant is proven by `orders/capacity.itest.ts` on a real Postgres (adr-ticketing.md
§3): 300 purchases at once on 100 seats hold exactly 100, never below zero, and all 100 come back at
expiry; measured over three runs, the 300 took 574, 634 and 946 ms with the fake provider and a pool
of ten. The load test at 10,000 buyers a minute is T6's.

Proven on the running stack on 2026-09-29 at 040190f, the four new migrations run on the database
that already held T2's dates, ticketing's three processes started from that build, a date drafted,
scheduled and engaged by catalog's facts sent on `arthome.catalog.date`, 5 seats at 24 EUR:

| Check | Result |
| --- | --- |
| `quoteSeat` for 3 | 200, one `tier` line of 7200 EUR, `validUntil` 60 s out |
| `purchaseSeat` for 3 | 201 in 40 ms: three seats `ATH-XXXXXX`, their cancel deadline an hour before the start, order `ATH-2026-00001` paid |
| the same key again | 201 in 5 ms, `Idempotency-Replayed: true`, the body byte for byte |
| 3 more under a new key | 409 `order.sold_out`, 2 seats left |
| `arthome.ticketing.order` | `order.paid`, key the order id, the request's `traceparent` |
| `arthome.ticketing.date_sales` | three `seat.activated` on the date's key, then the sweeper's `availability_changed` 0.25 s after the purchase |
| a webhook forged, then a genuine `payment_failed` twice | 401; 200 recorded; 200 `duplicate: true`; applied by the worker within 2.5 s, the paid order left paid |
| SIGTERM to the three | stopped, no ticketing connection left in `pg_stat_activity` |

Proven again on 2026-09-29 at d621b51, after both reviews' fixes, the three migrations
`1790440900000` to `1790441100000` run on that database, the three processes rebuilt, one date
started ten minutes before and one thirty-one minutes before, each opened by catalog's facts:

| Check | Result |
| --- | --- |
| a purchase on a date not started | 201, the order paid |
| the quote on the started date | 200 with `lateEntry`: `minutesElapsed` 10 and `salesEndAt` 30 min after the start |
| a purchase there, without then with `X-Arthome-Late-Entry-Acknowledged: true` | 409 `order.late_entry_unacknowledged` with the three facts, no hold nor order left; then 201 |
| the date past its cutoff | closed by the sweeper at its end, its last availability published; purchase and quote 409 `order.sales_closed` with `salesEndAt` |

Tx A, the provider call between two transactions, tx B, and why the key is the order's, are
`apps/ticketing/HANDOVER.md` §0h. A hold nobody paid expires in the sweeper within a second of its
instant, its seats back and its order failed (§0i). Run `migration:run` for `1790440500000` to
`1790440900000` with the three processes stopped, as for every ticketing migration; the last one
writes each scheduled sale's end, and the sweeper closes those already past it on its first pass.

### Search, the date page and link resolution, from the storefront BFF

`GET /v1/search` crosses three processes: `bff-storefront` (on `PORT`, `CATALOG_URL` pointing at
catalog, `http://localhost:3002` by default), catalog's API, which reads `arthome-catalog-date` at
`OPENSEARCH_URL`, and `search-indexer`, which writes it. Nobody calls the indexer.

```bash
cd apps/bff-storefront && PORT=3003 node dist/main.js
curl 'localhost:3003/v1/search?q=nuit&sort=soon' -H 'X-Arthome-Surface: storefront_tv'
```

The BFF gives catalog a deadline 200 ms out (`x-arthome-deadline`, transport.md §5.9), creates the
`traceparent` when the surface sent none, relays only `STOREFRONT_RELAYED_CODES`, and turns every
other failure into `api.upstream_unavailable` (502) or `api.upstream_timeout` (504). Catalog
refuses a call without a deadline. What catalog serves and refuses is in
`apps/catalog/HANDOVER.md` §0.

Proven on the running stack on 2026-09-26, with a show published on two dates through the studio
commands, the indexer, catalog and the BFF running:

| Check | Result |
| --- | --- |
| the index's `-v1` at the indexer's start | `slug_fr`, `slug_en`, `ends_at`, `over_at` added in place, no reindex |
| `q=nuit&sort=soon` | one group, `Nuits blanches`, `matchingDatesCount` 2, the 12 December date first, `scheduled` until the room opens, the envelope's `validUntil` that instant; facets counted in shows; `public, max-age=60` and the `Vary` list |
| latency through the BFF | 184 ms on the first call, cold; 18 to 38 ms over the next ten |
| `countryCodes=BE` | no group, `emptyReason: no_match_with_filters` |
| `priceMaxMinor` and `tab=artists` | catalog's 400 relayed, both fields named, the caller's `traceId` |
| `tab=concerts`, a studio surface | refused by the BFF, 400, before catalog is called |
| catalog without a deadline, or a past one | 400 naming `x-arthome-deadline`; 504 `api.deadline_exceeded` |
| OpenSearch paused | 504 `api.upstream_timeout` in 203 ms, and 200 again once it resumes |
| catalog stopped | 502 `api.upstream_unavailable` in 3 ms; the refused connection logged by the BFF |

The BFF also serves `GET /v1/dates/:dateId` (public, `max-age=60`, an `ETag` answered 304) and
`GET /v1/resolve` (public, `max-age=300`), from catalog's `date_detail_public` rather than the
index; `apps/catalog/HANDOVER.md` §0b says what they serve. Proven on the running stack on
2026-09-27, the migration applied to the stack above:

| Check | Result |
| --- | --- |
| the migration | `date_detail_public` created and filled with the two dates already published |
| the page through the BFF | 200 in 61 ms cold, 8 to 9 ms after; the venue's name, the synopsis, the other date in `seriesDates`, `validUntil` the room opening |
| the same request with its `ETag` | 304, no body |
| a French URL, the English one, `kind=date&slug=` | the same date, and its current canonical URL |
| an unknown slug; `kind=artist` | 404 `api.not_found`; 400 naming `kind` |
| the show retitled | the page carries the new title at once, and the old `ETag` no longer matches |
| a draft | 404 |

### When a message cannot be applied

Two reject paths, and they answer different questions.

| Failure | Example | What happens |
| --- | --- | --- |
| **permanent** | no `message-id` header, or one that is not a UUID; bytes that are not this schema | **dead-lettered at once**, `attempt: 0`, no replay |
| **transient** | database unavailable, lock, dependency down | retried after 5 s, 30 s, 5 min — each with jitter — then dead-lettered |

Anything unrecognised is treated as **transient**, deliberately: retrying a permanent failure costs
three attempts, while discarding a transient one loses the fact for good.

The retry and dead-letter topics are declared in `infra/kafka/topics.json`; `pnpm run provision:topics` creates them at the partition counts `events.md` §3 fixes. Not by hand and not by auto-creation — a second, hand-maintained source for the same fact is the parallel table this repository's own gate exists to refuse.

**Retry at ONE layer.** A client retry, the broker's own redelivery and this budget multiply:
three of each is twenty-seven attempts for one message, and an outage becomes an overload caused by
the retries. `@arthome-platform/messaging` is the single owner for business failures.

**A retry topic reorders one key's events.** Kafka's ordering holds per partition, and a message
that waits five minutes comes back behind later events for the same aggregate.

**`search-indexer` guards this.** `version_type: external_gte` on the OpenSearch write, with the
event's `occurred_at` in epoch milliseconds as the version, so an older event is refused by the index
rather than applied — and its read model (`show_projection`, `date_projection`) carries the same
condition per group of fields, so an update that overtakes a publication keeps its fields. Date
documents are versioned by a counter advanced under the date row's lock, since a show change moves
them too (`apps/search-indexer/HANDOVER.md` §0). Proven on the running stack on 2026-09-26, the first time the catalog half ran:
an event one hour older with a fresh `message-id` — which deduplication cannot catch — left the
document's `_version` and fields untouched, and the consumer reports it as `superseded`, not
`applied`. **`notifications` does not, and does not need to**: it handles one message type
and its effect is one row keyed by `account_id`, so there is no second event to arrive out of order.
**`catalog`'s checklist projection guards it the same way**: each fact carries the reporting
context's `occurred_at`, and the upsert refuses an older one (`superseded`). The next consumer that
applies two events whose order matters owes the same condition.

**The wait is held INSIDE the handler, and that is not an implementation detail.** KafkaJS resolves
a message's offset as soon as `eachMessage` **returns** — unconditionally, storing `offset + 1`. So
any mechanism that returns early and arranges to come back later (pause + `setTimeout` + `seek` is
the obvious one, and was here) commits past a message whose only copy is that retry record. A
restart, a SIGTERM deploy, an OOM kill or a reassignment inside the wait then drops a committed
business fact, silently — `seek` is a no-op once the partition has left the assignment, and the
replacement starts at `offset + 1`. On the third tier that window is five minutes wide, and it is the
window an incident creates. `waitUntilDue` therefore blocks in the handler, heartbeats every 3 s, and
**throws** on shutdown so the message is redelivered rather than committed and lost. The cost is
intended: the retry partition is held for the duration, which is what a retry topic is for.

**There is no dead-letter queue on the connector, and the logs will suggest otherwise.** Kafka
Connect implements `errors.deadletterqueue.*` for sink connectors only; the outbox router is a
source connector. It accepts the properties and Debezium echoes them back at startup, so the output
reads as though one were configured — the topic is never created. See
[`infra/debezium/README.md`](infra/debezium/README.md).

### One malformed outbox row kills the connector, and recovery is not obvious

Measured, not feared. A row whose `aggregatetype` contained a space produced
`InvalidTopicException`, and Connect's answer was *"Task is being killed and will not recover until
manually restarted."* Three things make it the worst failure on this path:

- **it is not per-record** — the task dies, so every later event from that service stops. The outbox
  is the service's only way out;
- **the slot then retains the WAL indefinitely**, which ends as a full disk rather than as an alert;
- **restarting the task does not help.** It reads the same row and dies again — and it dies again
  even after the row is deleted, because the failing record is already in the producer's
  accumulator.

No Connect setting reaches it: the failure is raised in the producer's send callback, past
`errors.tolerance` and past a dead-letter queue a source connector does not have.

**The recovery, in order.** Delete the offending row, then **restart the Connect worker**
(`docker compose restart connect`) to clear the producer's accumulator.

> **Do NOT drop the replication slot.** It looks like the decisive fix and it loses data: Debezium
> then recreates the slot at the CURRENT WAL position and every row not yet published is skipped for
> ever, sitting in the outbox that nothing reads back. Done here by accident, and the events were
> gone.

**Which is why the constraints exist.** `@arthome-platform/messaging` defines the outbox table with
CHECK constraints — topic-safe `aggregatetype`, non-empty `aggregateid`, versioned `type`, non-empty
`payload` — so the row cannot be committed in the first place, and the business operation is refused
inside the transaction, where a request is still waiting to be told.

**A replication slot nobody consumes retains the write-ahead log.** Stopping the connector and
leaving it registered makes the disk grow until it is full (`data-model.md` §7.4). `docker compose
down -v` removes everything, slot included.

## What this repository is

The seven NestJS microservices and their infrastructure. Two services first — `identity` and
`catalog` — but the whole event path end to end: the outbox inside the transaction, a versioned
Protobuf schema, CDC into the index, `traceparent` carried through.

The architecture, the ADRs and the arbitration log live in
**[arthome-core](https://github.com/jubasse/arthome-core)**, not here.
