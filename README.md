# arthome-platform

The **seven NestJS microservices** and the infrastructure: PostgreSQL (one database per service),
Kafka with Kafka Connect and Debezium, Redis, OpenSearch, MinIO.

`identity` · `catalog` · `ticketing` · `streaming` · `chat` · `payouts` · `notifications`

## Status

**The event path is built and proven end to end.** An account is registered over HTTP, the fact
reaches a second service's database through logical decoding, and replaying it changes nothing.
Every step below was run against the real stack, not reasoned about.

```
POST /accounts  ->  account + outbox_event in ONE transaction, same manager
                ->  Postgres WAL  ->  Debezium outbox router
                ->  arthome.identity.account, key = account_id
                ->  notifications: dedup + effect in ONE transaction
```

| Built | What it is |
| --- | --- |
| `apps/identity` | `POST /accounts`, the outbox producer |
| `apps/catalog` | shows, venues, dates and their publication, the checklist consumer, and `GET /v1/search` over the date index |
| `apps/notifications` | the idempotent consumer, with retries and dead-lettering |
| `apps/search-indexer` | the catalog projection into OpenSearch, composed from a read model of its own |
| `libs/messaging` | the outbox, failure classification, retry, dead-lettering — shared by every service |
| `libs/events` | the Protobuf wire types, generated from arthome-core's `proto/` |
| `libs/http-edge` | the success and error envelopes, validation refusals, the deadline — every HTTP service's edge |
| `libs/search-index` | the index mappings and document shapes, shared by the indexer and catalog's search |
| `libs/config`, `libs/testing` | the environment, and a harness that starts real containers |

**What is NOT built, said plainly.** `ticketing`, `streaming`, `chat` and `payouts` do not exist.
`notifications` is only its consumer half. There is no Redis and no MinIO. There is no authentication:
`adr-auth.md` gives it to better-auth in its own schema, and that is deliberately deferred.

`apps/search-indexer` is an **eighth** component and not one of the seven services — a projection
onto the index, owned by the search side rather than by a bounded context.

**Resilience, exercised rather than assumed.** Kafka and Connect fully stopped with traffic still
arriving; the consumer stopped and restarted; Debezium alone stopped; Postgres restarted under load.
Nothing lost, nothing doubled, in any of them — because the services never speak to the broker. A
permanent failure dead-letters at once; a transient one retries at 5 s, 30 s and 5 min with jitter.

**Infrastructure, at the versions that actually run.** PostgreSQL 18.6 with `wal_level=logical`,
Kafka 4.0 in KRaft mode, Debezium 3.0, OpenSearch 2.18. Postgres publishes on **55432**, not
5432: a development stack that fights for well-known ports is one you cannot run beside anything
else.

**`pnpm run verify` runs in under two seconds** and needs no Docker. The
integration tests that do need it are `*.itest.ts`, behind their own command — a gate that costs
half a minute stops being run, and then stops being true.

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
