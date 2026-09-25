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
  `nestjs-monorepo` (pnpm workspace)

Project decisions — the ADRs and `DECISIONS.md` in arthome-core — take precedence over these
community defaults, and a recorded decision is never reopened.

⚠ **THIS BLOCK EXISTS BECAUSE THE SKILLS WERE NOT LOADED.** `identity`, `notifications` and
`catalog` were all written without them; only `nestjs-event-driven` was opened, and late, at which
point it corrected two real defects that were already in the code — no jitter on retries, and no
guard against a retry topic reordering one aggregate's events. The rule the router states is
`MUST load skills before writing NestJS code`, and v12 changed ESM, Express 5, validation and the
error model. Skills trigger on their descriptions, and an agent that believes it already knows
NestJS skips them; this block is what makes loading systematic rather than remembered.

## Before you write anything

- **The domain is not defined here.** Entities, vocabularies, error codes and boundary DTOs come
  from `@arthome/core` and `@arthome/contracts`. A string literal that duplicates a vocabulary value
  is caught by `pnpm run check:enums`, and the fix is always the import, never the literal.
- **`vendor/` is build output of another repository.** Do not edit anything inside it. To pick up a
  change made in arthome-core, run `pnpm run bootstrap`.
- **After `pnpm run bootstrap`, restart your editor's ESLint server.** Bootstrap re-packs
  `@arthome/tooling`, so the shared ESLint configuration changes *inside `node_modules`* — and the
  extension only watches the root `eslint.config.js`, which did not move. The server keeps the flat
  config it loaded at startup and goes on reporting rules that no longer exist. In VS Code:
  **`ESLint: Restart ESLint Server`**.

  ⚠ **When the editor and the CLI disagree, believe the CLI and check before editing code.** It
  recomputes everything on each run; the editor holds state. This has now bitten twice here for two
  different reasons — a stale ESLint server, and the editor resolving types through `dist` — and
  both times the code was already correct. One command settles it:
  `pnpm exec eslint <the exact file> --max-warnings 0`.

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
pnpm run provision:topics          # BEFORE the connector, and before any consumer
curl -s -X POST -H 'Content-Type: application/json' \
  --data @infra/debezium/identity-outbox.json http://localhost:8083/connectors
```

⚠ **`provision:topics` is not a convenience.** A topic auto-created by the first producer takes the
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
| its headers | `message-id`, `type`, `traceparent` — the same traceparent the request carried |
| `notifications.welcome_email` | one row, holding that same traceparent |
| replaying the message | the consumer says `duplicate` and the row count does **not** move |

### When a message cannot be applied

Two reject paths, and they answer different questions.

| Failure | Example | What happens |
| --- | --- | --- |
| **permanent** | no `message-id` header, bytes that are not this schema | **dead-lettered at once**, `attempt: 0`, no replay |
| **transient** | database unavailable, lock, dependency down | retried after 5 s, 30 s, 5 min — each with jitter — then dead-lettered |

Anything unrecognised is treated as **transient**, deliberately: retrying a permanent failure costs
three attempts, while discarding a transient one loses the fact for good.

```bash
# the retry and dead-letter topics are per service, and are not auto-created
for t in arthome.notifications.retry arthome.notifications.dlq; do
  docker compose exec -T kafka /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server localhost:9092 --create --topic "$t" --partitions 3 --replication-factor 1
done
```

⚠ **Retry at ONE layer.** A client retry, the broker's own redelivery and this budget multiply:
three of each is twenty-seven attempts for one message, and an outage becomes an overload caused by
the retries. `@arthome-platform/messaging` is the single owner for business failures.

⚠ **A retry topic reorders one key's events.** Kafka's ordering holds per partition, and a message
that waits five minutes comes back behind later events for the same aggregate. Nothing guards this
yet — the guard is an aggregate version on the consumer's side, and it is owed the day a consumer
applies two events whose order matters.

⚠ **There is no dead-letter queue on the connector, and the logs will suggest otherwise.** Kafka
Connect implements `errors.deadletterqueue.*` for sink connectors only; the outbox router is a
source connector. It accepts the properties and Debezium echoes them back at startup, so the output
reads as though one were configured — the topic is never created. See
[`infra/debezium/README.md`](infra/debezium/README.md).

### ⚠ One malformed outbox row kills the connector, and recovery is not obvious

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

> ⚠ **Do NOT drop the replication slot.** It looks like the decisive fix and it loses data: Debezium
> then recreates the slot at the CURRENT WAL position and every row not yet published is skipped for
> ever, sitting in the outbox that nothing reads back. Done here by accident, and the events were
> gone.

**Which is why the constraints exist.** `@arthome-platform/messaging` defines the outbox table with
CHECK constraints — topic-safe `aggregatetype`, non-empty `aggregateid`, versioned `type`, non-empty
`payload` — so the row cannot be committed in the first place, and the business operation is refused
inside the transaction, where a request is still waiting to be told.

⚠ **A replication slot nobody consumes retains the write-ahead log.** Stopping the connector and
leaving it registered makes the disk grow until it is full (`data-model.md` §7.4). `docker compose
down -v` removes everything, slot included.

## What this repository is

The seven NestJS microservices and their infrastructure. Two services first — `identity` and
`catalog` — but the whole event path end to end: the outbox inside the transaction, a versioned
Protobuf schema, CDC into the index, `traceparent` carried through.

The architecture, the ADRs and the arbitration log live in
**[arthome-core](https://github.com/jubasse/arthome-core)**, not here.
