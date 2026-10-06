# arthome-platform

The **seven NestJS microservices** and the infrastructure: PostgreSQL (one database per service),
Kafka with Kafka Connect and Debezium, Redis, OpenSearch, MinIO.

`identity` · `catalog` · `ticketing` · `streaming` · `chat` · `payouts` · `notifications`

## Status

**The event path is built and proven end to end.** An account is registered over HTTP, the fact
reaches a second service's database through logical decoding, and replaying it changes nothing.
Every step below was run against the real stack, not reasoned about; the first step is now the
storefront BFF's sign-up (auth slice A), which reaches identity with its internal token.

```
POST /v1/auth/sign-up (BFF)  ->  identity: account + outbox_event in ONE transaction, same manager
                ->  Postgres WAL  ->  Debezium outbox router
                ->  arthome.identity.account, key = account_id
                ->  notifications: dedup + effect in ONE transaction
```

| Built | What it is |
| --- | --- |
| `apps/identity` | the storefront session on better-auth (sign-up, sign-in, sessions, the email verification link), the outbox producer |
| `apps/catalog` | shows, venues, dates and their publication, the checklist and run-fact consumer, the search over the date index, the public date page from `date_detail_public`, and the artist |
| `apps/ticketing` | a date's commercial face, `DateSales`: capacity by tiers and its technical provision, prices and their lock, the studio's pane, the public availability read, the facts it takes from catalog, and `availability_changed` at a bounded rate; the seat's quote, purchase and order: holds, orders and their payment through the fake adapter; a seat's cancellation by its viewer and its refund from the studio, and the provider's refund and dispute webhooks; a date's outcomes: a cancelled date's refunds, an interrupted one's credit notes, and the seats' deadlines following a postponement; the worker process, which makes every call owed to the provider, refunds and intent cancellations, from BullMQ's queues on Redis, and the refund ledger (`order_refund`, several per order) |
| `apps/notifications` | the idempotent consumer, with retries and dead-lettering |
| `apps/bff-storefront` | the storefront's BFF: search, the date and artist pages, link resolution, from catalog; the authentication relay and the viewer context, from identity; an internal token on every call, the deadline, the error mapping, the caps and the cookie's CSRF check |
| `apps/search-indexer` | the catalog projection into OpenSearch, composed from a read model of its own |
| `libs/messaging` | the outbox and each service's writer over it (`outboxWriter`), the host a Nest consumer process runs its consumers in (`ConsumerHostModule`, from `@arthome-platform/messaging/nest`, the one entry that loads Nest), the processed-message claim (`claimMessage`, `messageIdOf`: a message-id that is not a UUID is dead-lettered at once), failure classification, retry and its schedule (`nextAttemptAt`, `doublingDelays`, for provider calls too), dead-lettering — shared by every service; `retryDelayAfter`, the same schedule as a queue's backoff |
| `libs/events` | the Protobuf wire types, generated from arthome-core's `proto/` |
| `libs/http-edge` | the success and error envelopes and the global providers that bind them (`edgeProviders`), the internal token's verification and its guard, validation refusals, the refusals a handler raises at the status core's error registry gives their code (`refuse(route, code, params)` on a bound route, `refusalOf`, `notFound`, `stateConflict`), the deadline, idempotent commands and their table, JSON as the only body parsed (`JsonBodiesOnly`), a handler bound to its `@arthome/contracts` route (`Endpoint`), with the guards, input, principal and answer shaping its declaration implies (`endpointProviders`) — every HTTP service's edge |
| `libs/search-index` | the index mappings and document shapes, shared by the indexer and catalog's search |
| `libs/transactions` | the transaction a CQRS command runs in, its domain events published after the commit, `frozen`, which holds an aggregate's snapshot, and `updateReturning`, which reads an UPDATE's RETURNING rows |
| `libs/config`, `libs/testing` | the environment, and a harness that starts real containers, pauses one for an outage drill (`StartedStack.pause`), registers a service's committed connector (`registerOutboxConnector`), boots a service's feature modules over HTTP (`httpApp`) and checks each response a suite provokes against its contract route (`guardDeclaredResponses`) |

**What is NOT built, said plainly.** `streaming`, `chat` and `payouts` do not exist, and `ticketing`
sells through its fake payment adapter only, with no Stripe adapter; refunds for an outcome, the
waiting list and the waiting room come next.
`notifications` is only its consumer half, and sends no email. Redis holds the storefront BFF's
authentication caps and ticketing's provider-call queues; the waiting room comes next. There is no
MinIO.
Authentication covers the storefront's session (auth slice A): the studio (B), devices and the
television (C), and the other sign-in methods (D) come next, and the studio's routes stay refused in
production until B authorises them.

`apps/search-indexer` is an **eighth** component and not one of the seven services — a projection
onto the index, owned by the search side rather than by a bounded context.

**Resilience, exercised rather than assumed.** Kafka and Connect fully stopped with traffic still
arriving; the consumer stopped and restarted; Debezium alone stopped; Postgres restarted under load.
Nothing lost, nothing doubled, in any of them — because the services never speak to the broker. A
permanent failure dead-letters at once; a transient one retries at 5 s, 30 s and 5 min with jitter.

**Infrastructure, at the versions that actually run.** PostgreSQL 18.6 with `wal_level=logical`,
Kafka 4.0 in KRaft mode, Debezium 3.0, OpenSearch 2.18, Redis 8.8 with no eviction and an
append-only file. Postgres publishes on **55432**, not 5432, and Redis on **56379**: a development
stack that fights for well-known ports is one you cannot run beside anything else.

**`pnpm run verify` needs no Docker**, and stays fast enough to run on every commit because it is
cached: ESLint, Prettier and `tsc` each skip what has not changed — warm, about 25-55 s; cold, about
110-140 s. Caching a cross-file lint check has a cost: a warm `verify` can miss a lint error that
only shows up through another file's change. `pnpm run verify:full`, the same gate with every cache
off, closes that gap and is what `.githooks/pre-push` runs before every push, so a PR never reaches
review without it. The integration tests that do need Docker are `*.itest.ts`, behind their own
command.

**Setting up.** The `@arthome/*` packages come from a release of arthome-core, with nothing cloned
beside this repository: `pnpm run use-core <version>` points the manifests at the tarballs attached
to the GitHub release `v<version>`, installs, and builds the libs. The platform is on core 0.1.0, from
its GitHub release. The first switch off `file:` specs needs `node tools/use-core.mjs <version>`, since
pnpm 12 pre-installs before a script and fails on missing vendor tarballs; later bumps can use
`pnpm run use-core`. To work against arthome-core
changes that are not released, `pnpm run bootstrap` packs a sibling checkout instead; that is for
feature branches, and `develop` and `main` must stay on a release.

See **[AGENTS.md](AGENTS.md)** for the commands, how to replay the event path, and what happens when
a message cannot be applied.

## Where the design lives

The architecture, the interface contracts, the decisions and their reasons all live in
**[arthome-core](https://github.com/jubasse/arthome-core)**:

- `architecture/` — the context map, the data model, the event catalogue, the ADRs
- `openapi/` — the contracts of the two BFFs
- `proto/` — the Kafka event schemas
- `DECISIONS.md` — the arbitration log
- `architecture/critical-rules.md` — **re-read it every session**, nineteen lines

## Arthome

A streaming platform for live performance: ticketing, live, moderated chat, replays,
merchandise, artist payouts. Two products — a public storefront and a professional studio — across
five surfaces, served by seven microservices.
