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

## Before you write anything

- **The domain is not defined here.** Entities, vocabularies, error codes and boundary DTOs come
  from `@arthome/core` and `@arthome/contracts`. A string literal that duplicates a vocabulary value
  is caught by `pnpm run check:enums`, and the fix is always the import, never the literal.
- **`vendor/` is build output of another repository.** Do not edit anything inside it. To pick up a
  change made in arthome-core, run `pnpm run bootstrap`.
- **`pnpm run verify` is the gate.** Run it before every commit — and chain with `&&`, never `;`:
  this project has twice pushed with a red `verify` because a `;` let the commit run anyway.

## The commands

| command | what it does |
| --- | --- |
| `pnpm run bootstrap` | packs the sibling arthome-core into `vendor/`, then installs |
| `pnpm run verify` | everything below, in order, stopping at the first failure |
| `pnpm run verify:offline` | the subset needing no install — vendor, versions, tsconfig, enums, language |
| `pnpm run check:enums` | string literals that duplicate a domain vocabulary |
| `pnpm run fix` | Prettier, then ESLint `--fix`, then Prettier again |

## Running the event path

The stack is three containers: Postgres 18 with `wal_level=logical`, Kafka in KRaft mode, and Kafka
Connect carrying Debezium. **Postgres publishes on 55432, not 5432** — the conventional port was
taken by another project, and a development stack that fights for well-known ports is one you
cannot run beside anything else.

```bash
docker compose up -d
pnpm --filter @arthome-platform/identity      run migration:run
pnpm --filter @arthome-platform/notifications run migration:run
curl -s -X POST -H 'Content-Type: application/json' \
  --data @infra/debezium/identity-outbox.json http://localhost:8083/connectors
```

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
| its headers | `message-id`, `type`, `traceparent` — the same traceparent the request carried |
| `notifications.welcome_email` | one row, holding that same traceparent |
| replaying the message | the consumer says `duplicate` and the row count does **not** move |

⚠ **A replication slot nobody consumes retains the write-ahead log.** Stopping the connector and
leaving it registered makes the disk grow until it is full (`data-model.md` §7.4). `docker compose
down -v` removes everything, slot included.

## What this repository is

The seven NestJS microservices and their infrastructure. Two services first — `identity` and
`catalog` — but the whole event path end to end: the outbox inside the transaction, a versioned
Protobuf schema, CDC into the index, `traceparent` carried through.

The architecture, the ADRs and the arbitration log live in
**[arthome-core](https://github.com/jubasse/arthome-core)**, not here.
