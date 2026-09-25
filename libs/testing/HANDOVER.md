# `@arthome-platform/testing` — handover

Written at the end of the session that built it. Everything below was run; nothing is claimed
from reading.

---

## 1. What is here, and how a test uses it

| File | What it gives |
| --- | --- |
| `src/stack.ts` | `startPostgres`, `startKafka`, `startStack`, `composeImage`. Containers, and a `stop()`. |
| `src/kafka.ts` | `createTopics`, `waitForMessage`, `headersOf`. The waiting an event test cannot do without. |
| `src/database.ts` | `createDatabase`, `applyMigrations`, `truncateAll`. |
| `src/index.ts` | The public surface. The placeholder is gone. |
| `src/stack.spec.ts`, `src/kafka.spec.ts` | **Fast, no Docker.** These two run inside `pnpm run verify`. |
| `src/stack.itest.ts`, `src/kafka.itest.ts`, `src/outbox.itest.ts` | **Slow, Docker.** 13 tests. |
| `vitest.integration.config.mjs` | The only thing that can find a `*.itest.ts`. |

```ts
import { OutboxEvent, writeOutboxEvent } from '@arthome-platform/messaging';
import { applyMigrations, createDatabase, startStack, truncateAll } from '@arthome-platform/testing';

const stack = await startStack({ postgres: true });          // Kafka is not started, nor paid for
const target = await createDatabase(stack.postgres, 'identity_itest');
const dataSource = await applyMigrations(target, {
  entities: [Account, OutboxEvent],
  migrations: [Initial1758700000000, OutboxGuards1758700200000],
});

await dataSource.transaction((manager) => writeOutboxEvent(manager, fact));
// ... assertions ...

await truncateAll(dataSource);   // between tests
await dataSource.destroy();      // BEFORE stack.stop(): a live pool keeps Node alive
await stack.stop();
```

And for Kafka:

```ts
const stack = await startStack({ kafka: true });
const kafka = new Kafka({ clientId: '…', brokers: [...stack.kafka.brokers], logLevel: logLevel.NOTHING });

await createTopics(kafka, [{ topic: 'arthome.identity.account', partitions: 3 }]);
const message = await waitForMessage(kafka, {
  topic: 'arthome.identity.account',
  matches: (m) => m.headers['message-id'] === messageId,
  timeoutMs: 30_000,
});
expect(message.key).toBe(accountId);            // the partition key
expect(message.headers).not.toHaveProperty('traceparent');   // Debezium's literal "null" is absent
```

### What was actually run, and what it said

```
pnpm --filter @arthome-platform/testing exec tsc --noEmit -p tsconfig.json     clean
pnpm --filter @arthome-platform/testing exec eslint src --max-warnings 0       clean
pnpm --filter @arthome-platform/testing exec prettier --check "src/**/*.ts"    clean
pnpm --filter @arthome-platform/testing exec vitest run        2 files, 6 tests, 0.5 s, NO Docker
pnpm --filter @arthome-platform/testing run test:integration   3 files, 13 tests, 13 s, Docker
```

Also run, read-only, because a red `verify` for the parent session would cost more than the
command list saves: `arthome-check-tsconfig` (PASS, 17 projects) and `arthome-check-enums`
(PASS, 56 enumerations). `arthome-check-language` was **not** run usefully: it reads
`git ls-files`, and these files are untracked until the parent commits. I grepped them by hand
against its stop-word list instead — no hits.

`vitest list --dir libs/testing` from the repository root collects the two `.spec.ts` files and
nothing else. That is the mechanism, verified rather than assumed.

---

## 2. What only I know

### 2.1 There is no testcontainers module for Postgres or Kafka here

Only the generic `testcontainers` package is installed — `@testcontainers/postgresql` and
`@testcontainers/kafka` are not, and I could not add them. **Both containers are therefore built
by hand from `GenericContainer`**, which is why `stack.ts` is longer than a reader expects. If
those modules are ever added, most of `startKafka` can be deleted; `startPostgres` would still
need the `compose.yaml` reader, which is the part that carries the guarantee.

### 2.2 The image tags and the Postgres flags are READ out of `compose.yaml`, not copied

`composeImage('postgres')` and the `command:` list are parsed out of the repository's
`compose.yaml` at run time. The alternative — two constants in this file — is a parallel literal
table on the one value whose drift is invisible: a harness pinned to `postgres:17` would pass
every test while saying nothing about the Postgres anybody runs.

- The file is found with `new URL('../../../compose.yaml', import.meta.url)`. `src/` and `dist/`
  sit at the same depth under `libs/testing`, so one path serves the source and the build, and
  the working directory is irrelevant (a test is run from the root, from `libs/testing`, and from
  an editor).
- **If `libs/testing` ever moves, this throws** with a message that says so. That was chosen over
  a fallback constant, which would have been the copy again, silently winning.
- The parser is indentation-based and deliberately small. It is covered by `src/stack.spec.ts` —
  **a fast test, inside `verify`** — because a reader that returns the *wrong* service's image
  makes everything pass. Those assertions match the shape (`/^postgres:\S+$/`), never the tag: a
  version bump in `compose.yaml` must not turn red in a package that has no opinion about it.
- The `command:` parser is not unit-tested directly. It is asserted end to end instead:
  `outbox.itest.ts` runs `SHOW wal_level` against the started container and requires `logical`.
  `startPostgres` makes the same check itself and refuses to hand back a server that fails it —
  because at `replica` there is nothing in the WAL for Debezium to read, and every future CDC
  test would be a green false negative.

### 2.3 Kafka: the advertised-listener problem, and the three ways it can be got wrong

A broker tells its clients where to reconnect. `advertised.listeners` must name the **host** port
Docker mapped, which is not known until the container exists. Advertise the container-internal
port instead and every producer connects once, is redirected to a port nobody published, and
hangs until its request timeout — with an error about the broker being unreachable rather than
about the address being wrong.

What I did, and why not the alternatives:

- **Two-phase start.** The container comes up running `sh -c 'echo <marker>; until grep -q …;
  do sleep 0.1; done; exec sh /tmp/arthome-kafka-start.sh'`; the wait strategy is that marker in
  the log; then the mapped port is read off the started container, the starter script is written
  with the real address, and the shell hands over to the image's own `/etc/kafka/docker/run`.
  This is what the upstream testcontainers Kafka module does, and it is race-free.
- **Not a pre-reserved host port.** Asking the kernel for a free port, closing it and handing the
  number to Docker is half the code and leaves a window in which anything on the machine can take
  it. Rare, unreproducible, and indistinguishable from a broken test.
- **The shell waits for the LAST LINE of the script, not for the file.** `docker cp` creates the
  file and then fills it, so `[ -f … ]` can hand a half-written script to `sh` — a syntax error
  inside a container, at a moment when nothing is watching the logs. The script ends with
  `# ARTHOME_SCRIPT_COMPLETE` and the loop greps for it.
- The image runs as `appuser` (uid 1000), so the script goes to `/tmp` and is invoked as
  `sh <path>` rather than executed — mode `0644` is enough and no ownership question arises.
- `CLUSTER_ID` is generated per container, so two harness brokers side by side never look to each
  other like two halves of one cluster.
- `KAFKA_CONTROLLER_QUORUM_VOTERS` is `1@localhost:9093`, not compose's `1@kafka:9093`: `kafka` is
  the compose service's DNS name and there is no second container here.
- `KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: 0` is kept from compose and is **not** cosmetic. The
  default is three seconds of deliberate waiting for more group members, paid by every consumer
  `waitForMessage` creates — per test.

**Readiness is a metadata request, not a log line.** "Kafka Server started" is printed before the
controller has finished electing itself, and a client that connects in between gets a metadata
response with no leaders, which KafkaJS reports as an unrelated topic error. `startKafka` polls
`admin.listTopics()` until it answers.

### 2.4 Postgres starts TWICE, and the obvious readiness check passes during the first one

The official entry point runs the whole initialisation against a UNIX socket with
`listen_addresses` empty, and prints *"database system is ready to accept connections"* while
doing it — then shuts that server down and starts the real one. A `pg_isready` over the socket
therefore succeeds on a server that is about to disappear, and a test that connects in that window
has its connection dropped mid-query.

The wait is `Wait.forAll([forListeningPorts(), forSuccessfulCommand('pg_isready -h 127.0.0.1 …')])`.
The TCP port rules out the init phase (nothing is listening on TCP during it); `pg_isready` over
TCP then rules out a port that is open but not yet answering.

### 2.5 `pg` ships no TypeScript types, and `@types/pg` is not installed

`pg@8.23.0` has no `types` field and no bundled `.d.ts`. `import { Client } from 'pg'` therefore
fails `tsc` under `strict`. **Every statement in this package goes through TypeORM's
`DataSource.query` instead**, including `CREATE DATABASE` and `SHOW wal_level`. If someone later
wants raw `pg`, `@types/pg` has to be added to `libs/testing/package.json` first — an install,
which was outside my remit.

`DataSource.query<T = any>` defaults to `any`, so every call here passes an explicit type
argument; without one, `@typescript-eslint/no-unsafe-*` fails the lint.

### 2.6 `@arthome/core` is NOT a dependency of this package, and that shapes the test data

`libs/testing/package.json` depends on `@arthome-platform/messaging`, `kafkajs`, `pg`,
`testcontainers` and `typeorm`. It cannot import `Service`, `SERVICES` or any other vocabulary.

`arthome-check-enums` still sweeps these files, so a literal `'identity'` or `'notifications'`
would be a hard failure with no constant available to fix it. Everything in the tests is therefore
named out of no bounded context on purpose: database `harness_outbox`, topic
`arthome.harness.probe`, aggregate type `harness.probe`, event type `harness.probe.happened.v1`.

**If a future integration test needs real service names, `@arthome/core` must be added to this
package's dependencies** (`file:../../vendor/arthome-core-41a7a1edfeb9.tgz`, as the services
declare it) and installed. I could not do either.

### 2.7 `*.itest.ts` is invisible to Vitest's defaults — and to two things it perhaps should not be

The naming is what keeps `pnpm run verify` fast and Docker-free. Verified: `*.itest.ts` matches
neither `**/*.{test,spec}.?(c|m)[jt]s?(x)` (Vitest) nor `\.spec\.|\.test\.` (the gates). Two
consequences nobody will expect:

- **`arthome-check-enums` DOES sweep `.itest.ts` files.** Its skip pattern is `\.spec\.|\.test\.`,
  and `.itest.` matches neither. Integration tests are held to the vocabulary rule; spec files are
  not. That is arguably the right way round, but it is not obvious, and it is why §2.6 matters.
- **ESLint's test-file relaxation does NOT apply to `.itest.ts`.** Checked with
  `eslint --print-config`: in a `.spec.ts`, `no-console` is `off` and
  `@typescript-eslint/no-non-null-assertion` is `off`; in an `.itest.ts` they are `warn` and
  `error`. So an integration test may not use `console.log` (under `--max-warnings 0` that is a
  failure) and may not use `!`. The override lives in `@arthome/tooling`'s ESLint base, reached
  through `eslint.config.js` — **outside my tree, so I did not touch it.** If integration tests are
  meant to log, the fix is a local block in `eslint.config.js` adding `'**/*.itest.{ts,tsx}'`
  beside the two existing patterns.

Vitest has **no `--include` CLI flag** (only `--exclude` and `--dir`), so an alternative
`include` can only come from a config file. `vitest.integration.config.mjs` is deliberately named
outside Vitest's own discovery list (`vitest.config.{js,mjs,cjs,ts,…}`) so the fast run cannot
pick it up. It is `.mjs` and not `.ts` on purpose: a `.ts` file at a package root belongs to no
`tsconfig`, and typescript-eslint's `projectService` would fail the repository-wide
`pnpm run lint` on it.

### 2.8 Two smaller decisions worth a line each

- **`headersOf` delegates to `header()` from `@arthome-platform/messaging`.** The
  `"null"`-means-absent rule has exactly one implementation, in `dispatch.ts`. A second copy here
  would be a parallel implementation of the one rule whose divergence is invisible: both versions
  return a string, and only one of them is a trace id.
- **`truncateAll` spares the `migrations` table.** Emptied, it tells TypeORM nothing has ever run,
  and the next `runMigrations` replays `CREATE TABLE` against a schema that still holds every
  table — the suite then dies on *"relation already exists"* in a different test from the one that
  truncated. `RESTART IDENTITY` so a sequence does not carry test order into an assertion;
  `CASCADE` so the truncate order is not a second hand-maintained model of the schema.
- **`tsconfig.build.json` now excludes `src/**/*.itest.ts`.** They import `vitest`, which is a
  devDependency of the repository and not of this package; emitted into `dist/`, the built harness
  carried two modules whose imports cannot resolve. That was the state before I changed it — I
  ran `pnpm --filter @arthome-platform/testing run build` and saw `dist/kafka.itest.js`.

---

## 3. Things I found OUTSIDE my tree and did not change

1. **`libs/messaging/src/consume.ts:72` copies a constant that the same package exports.**

   ```ts
   const origin = header(payload, 'arthome-origin-topic') ?? payload.topic;
   ```

   `ORIGIN_HEADER = 'arthome-origin-topic'` is declared at `libs/messaging/src/dispatch.ts:8`,
   exported from `libs/messaging/src/index.ts:15`, used by `dispatch()` at `dispatch.ts:75`, and
   `consume.ts` already imports three other names from that very module. This is the only place
   the literal is written twice.

   **The failure it hides is silent and is exactly the one the retry path exists for.** Change
   `ORIGIN_HEADER` and `dispatch()` writes the new name while `runConsumers` reads the old one;
   `byTopic.get(origin)` then misses, the message is dispositioned `ignored`, and a retried
   message is quietly dropped instead of being reapplied. No test fails — `failure.spec.ts` covers
   the pure routing, and nothing exercises the retry consumer. One-line fix, in a tree that is not
   mine.

2. **KafkaJS 2.2.4 emits `TimeoutNegativeWarning` on every integration run.** Traced with
   `--trace-warnings`:

   ```
   at RequestQueue.scheduleCheckPendingRequests (kafkajs/src/network/requestQueue/index.js:317:37)
   at RequestQueue.checkPendingRequests       (kafkajs/src/network/requestQueue/index.js:297:10)
   at RequestQueue.fulfillRequest             (kafkajs/src/network/requestQueue/index.js:206:10)
   ```

   It is a bug inside the library, not in this harness, and it is harmless (Node clamps the
   timeout to 1 ms). It will appear in `apps/notifications` output too. Nothing in this repository
   can fix it; it is worth knowing so nobody spends an hour on it.

3. **`AGENTS.md` changed on disk during this session**, by somebody else. I did not read the new
   version and did not touch it.

---

## 4. Blockers, and what I did instead

| Blocked on | What I did |
| --- | --- |
| No `@testcontainers/postgresql` / `@testcontainers/kafka`, and no install allowed | Built both containers from `GenericContainer`, §2.1 and §2.3. |
| `pg` has no types and `@types/pg` is absent | Everything goes through TypeORM, §2.5. |
| `@arthome/core` not a dependency, so no domain vocabulary importable | Named all test fixtures outside every bounded context, §2.6. |
| Vitest has no `--include` flag | A second config file, named outside Vitest's discovery, §2.7. |
| ESLint's test relaxations do not reach `.itest.ts`, and `eslint.config.js` is not mine | Wrote the integration tests without `console` and without `!`. Reported it, §2.7. |
| `arthome-check-language` reads `git ls-files`, and my files are untracked | Grepped them by hand against its stop-word list: no hits. It will be a real check after the parent's commit. |

I ran no `git` command, no `pnpm install`, no `docker compose` command, and touched nothing
outside `libs/testing/`. Testcontainers started and stopped its own containers; `docker ps -a`
after the last run shows the four development-stack containers up and healthy and no leftovers of
mine.

---

## 5. What I did NOT do, and what is left

- **No OpenSearch container.** This package's own `description` promises one. `composeImage`
  already reads its tag, and `startOpenSearch` is about fifteen lines on the pattern of
  `startPostgres` (wait on `GET /_cluster/health` with `Wait.forHttp`). Nothing needs it yet, so I
  did not write code with no caller.
- **No Kafka Connect / Debezium container.** The harness can start Postgres with `wal_level=logical`
  and a broker, which is everything the connector needs — but registering the connector, waiting
  for the snapshot and asserting a row becoming a message is a second piece of work, with its own
  failure modes (the connector's startup is slow, and a source connector has no dead-letter queue
  to inspect). **This is the obvious next step and the one that would prove the whole event path.**
- **No test drives `identity` + `notifications` end to end.** That test belongs in `apps/*`, not
  here: this package cannot import them, and making it depend on two services would invert the
  dependency. The harness is what such a test would use.
- **`waitForMessage` reads one topic per call.** A test that must assert on a message *not*
  arriving still has to write its own loop.
- **No retry/dead-letter helper.** `dispatch()` publishes to `arthome.<service>.retry` and
  `.dlq`; asserting on those needs only `createTopics` + `waitForMessage`, so I added no third
  thing until a test asks for it.
- **`startStack` is not reference-counted.** Two test files each get their own containers; three
  files means three sets. That is what makes them independent and it is why the suite is 13 s
  rather than 40 s — the files run in parallel. If it ever becomes too slow, the answer is a Vitest
  `globalSetup`, not a shared singleton inside `stack.ts`.
- **`vitest` is not declared as a dependency of this package.** It resolves from the repository
  root by walk-up, which is why the tests run. Declaring it needs an install.
