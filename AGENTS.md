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
  `nestjs-bff-gateway` (`apps/bff-storefront`) · `nestjs-auth` (better-auth in `apps/identity`,
  jose in `libs/http-edge` and the BFF's minter) · `nestjs-web-security` (@nestjs/throttler,
  @fastify/cookie and @fastify/csrf-protection in `apps/bff-storefront`) ·
  `nestjs-cqrs` (@nestjs/cqrs, `apps/catalog`,
  `apps/ticketing`, `libs/transactions`, `libs/testing`'s `httpApp` and
  `@arthome-platform/messaging/nest`'s `ConsumerHostModule`, whose conventions are
  `apps/catalog/HANDOVER.md` §0f) ·
  `nestjs-ddd` (catalog's aggregates and repository ports, which `nestjs-cqrs` routes to) ·
  `nestjs-queues` (bullmq, @nestjs/bullmq, ticketing's worker)

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

Naming, comments, dependencies, pinned actions, and the checks to walk before handing a change over.
Read it before the first line of a task.

Full text: [`docs/agents/before-you-write.md`](docs/agents/before-you-write.md).

## The commands

| command | what it does |
| --- | --- |
| `pnpm run use-core <version>` | points every `@arthome/*` spec at the arthome-core release `v<version>`, refreshes the lockfile, builds every lib |
| `pnpm run bootstrap` | local mode: packs the sibling arthome-core into `vendor/`, installs, then builds every lib (`build:libs`) |
| `pnpm run check:core-specs` | every `@arthome/*` spec is one build of one source; `--require-release` also refuses a `file:` spec |
| `pnpm run build:libs` | `tsc -p tsconfig.build.json` in every `libs/*`; builds each lib's `dist/` |
| `pnpm run verify` | everything below, in order, stopping at the first failure — cached |
| `pnpm run verify:full` | the same, every cache off; what `.githooks/pre-push` runs before a push |
| `pnpm run verify:offline` | the subset needing no install — core specs, versions, tsconfig, enums, language, symbols |
| `pnpm run check:enums` | string literals that duplicate a domain vocabulary |
| `pnpm run fix` | Prettier, then ESLint `--fix`, then Prettier again |
| `pnpm run test:affected` | Vitest limited to what changed against `origin/develop` — the agent's working loop, not the gate |
| `pnpm run test:integration` | the container suites (`*.itest.ts`) that `verify` skips; needs Docker. Run it after touching a consumer, the outbox or `libs/testing` |
| `pnpm run test:integration:affected` | the same suites, limited to packages changed against `origin/develop` and their dependents |
| `PE1_HOLD_MINUTES=<n> pnpm --filter @arthome-platform/streaming exec vitest run --config vitest.integration.config.mjs src/drills/viewer-playback.itest.ts` | the viewer-playback drill held up for a browser run: it prints the BFF and edge URLs, the date and a drill account (`apps/streaming/HANDOVER.md` §0h) |
| `pnpm run purge:retention <service>` | what the retention job would delete; `--apply` to do it |
| `pnpm run ops:check <service>` | the operational checks (streaming adds failed assets, orphan recordings, idle rooms, `apps/streaming/HANDOVER.md` §0i); exits 1 when anything is degraded |
| `pnpm run republish:outbox <service>` | outbox rows never published to their topic; `--apply` republishes them |
| `pnpm --config.verify-deps-before-run=false exec schematics ./tools/schematics:<generator>` | the generators below; a dry run unless `--no-dry-run` |

## Generating a service, an aggregate, a command, a consumer handler

The schematics collection in `tools/schematics`: a service, an aggregate, a command, a consumer handler.
How to run a generator and what each one touches.

Full text: [`docs/agents/generating.md`](docs/agents/generating.md).

## Binding a route to its contract operation

Binding a route to its contract operation with `@Endpoint(route)` from `@arthome-platform/http-edge`.
What the decorator fills in and what stays yours.

Full text: [`docs/agents/binding-a-route.md`](docs/agents/binding-a-route.md).

## Gates: three levels

Three levels of checking for three moments: the agent loop, the commit, the push and the PR.
Which command is which, and what each one skips.

Full text: [`docs/agents/gates.md`](docs/agents/gates.md).

## Running the event path

The event path is three containers: Postgres 18 with `wal_level=logical`, Kafka in KRaft mode, and
Kafka Connect carrying Debezium. OpenSearch serves the search, and Redis 8.8 holds the storefront
BFF's authentication caps and the queues of ticketing's worker, the one process that queues there
(the waiting room, T6, is to come), with no eviction and an append-only file (`nestjs-queues` rule 6). **Postgres publishes on 55432, not 5432, and Redis on 56379, not 6379** — the
conventional port was taken by another project, and a development stack that fights for well-known
ports is one you cannot run beside anything else.

```bash
docker compose up -d
export NODE_ENV=development       # required, and never defaulted — see below
pnpm --filter @arthome-platform/identity      run migration:run
pnpm --filter @arthome-platform/identity      run migration:auth   # better-auth's schema, `auth`
pnpm --filter @arthome-platform/notifications run migration:run
pnpm --filter @arthome-platform/catalog       run migration:run
pnpm --filter @arthome-platform/search-indexer run migration:run
pnpm --filter @arthome-platform/ticketing     run migration:run   # its four processes stopped first
pnpm --filter @arthome-platform/streaming     run migration:run
pnpm run provision:topics          # BEFORE the connectors, and before any consumer
for c in identity catalog ticketing streaming; do
  curl -s -X POST -H 'Content-Type: application/json' \
    --data @infra/debezium/$c-outbox.json http://localhost:8083/connectors
done
```

The environment variables, the first run and the walkthroughs: [`docs/agents/event-path.md`](docs/agents/event-path.md).

### The catalog date path

Catalog's two processes and the date path from draft to published, then live and ended.
The requests to send and the events to expect.

Full text: [`docs/agents/catalog-date-path.md`](docs/agents/catalog-date-path.md).

### The ticketing date sales path

Ticketing's four processes and the date sales path: opening, availability, closing.
The requests to send and the events to expect.

Full text: [`docs/agents/ticketing-date-sales-path.md`](docs/agents/ticketing-date-sales-path.md).

### The ticketing purchase path

The purchase path on the running stack: hold, pay, ticket, refund.
The requests to send and what each step writes.

Full text: [`docs/agents/ticketing-purchase-path.md`](docs/agents/ticketing-purchase-path.md).

### Search, the date page and link resolution, from the storefront BFF

`GET /v1/search` and the date page across the storefront BFF, catalog and the search indexer.
What each process does and how a link resolves.

Full text: [`docs/agents/storefront-search-and-date-page.md`](docs/agents/storefront-search-and-date-page.md).

### When a message cannot be applied

The two reject paths for a message a consumer cannot apply, and what each one answers.
The contract that consumers and their tests hold to.

Full text: [`docs/agents/message-cannot-be-applied.md`](docs/agents/message-cannot-be-applied.md).

### One malformed outbox row kills the connector, and recovery is not obvious

Why one malformed outbox row kills the Debezium connector, and the recovery in order.
Measured, not feared.

Full text: [`docs/agents/malformed-outbox-row.md`](docs/agents/malformed-outbox-row.md).

### The media plane, in development (MediaMTX)

`compose.media.yaml`, the `arthome-media` project: MediaMTX origin, edge and Envoy.
Ports, the streaming API's part in it, and how to publish.

Full text: [`docs/agents/media-plane.md`](docs/agents/media-plane.md).

## What this repository is

What the repository holds and where the architecture, the ADRs and the arbitration log live.
The seven services and the event path in a paragraph.

Full text: [`docs/agents/what-this-repository-is.md`](docs/agents/what-this-repository-is.md).
