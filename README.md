# arthome-platform

The **seven NestJS microservices** and the infrastructure: PostgreSQL (one database per service),
Kafka with Kafka Connect and Debezium, Redis, OpenSearch, MinIO.

`identity` · `catalog` · `ticketing` · `streaming` · `chat` · `payouts` · `notifications`

## Status

**Not started.** Tier 2 — the distributed foundation. Two services first (`identity`, `catalog`),
but the whole event path end to end: the outbox inside the transaction, a versioned Protobuf
schema, CDC into the index, `traceparent` carried through.

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
