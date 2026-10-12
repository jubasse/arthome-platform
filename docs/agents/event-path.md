# Running the event path, after the first run

**`NODE_ENV` is required and deliberately has no default**, which is why it is exported before
anything else here. Every other variable a service reads — `DATABASE_URL`, `KAFKA_BROKERS`, `PUBLIC_WEB_ORIGIN`,
`OPENSEARCH_URL`, `REDIS_URL`, `PAYMENT_WEBHOOK_SECRET`, `IDENTITY_URL`, `STREAMING_URL`, `JWKS_URL`,
`INTERNAL_TOKEN_SIGNING_KEY`, `BETTER_AUTH_SECRET`, `CSRF_SECRET`, `PLAYBACK_SIGNING_KEY`,
`STREAM_KEY_SECRET`, `PLAYBACK_COOKIE_DOMAIN` (unset: host-only) — is filled from a local default
**only outside production**, and `NODE_ENV` is
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
answers 201. Both routes are exempt from the internal token's guard and from
`DenyInProductionGuard`. Ticketing's payment webhook is exempt from the token alone, since its
signature authenticates it.

**Every other route needs a BFF's internal token** (`libs/http-edge`'s
`InternalTokenGuard`, critical rule 4): ES256, verified locally against `JWKS_URL`, or outside
production against the development key `libs/config` publishes. A `curl` straight to a service
answers 401: go through the BFF, or mint one with `@arthome-platform/testing`'s
`mintInternalToken`. `DenyInProductionGuard` still runs behind it, refusing in production the
routes no slice has authorised yet: catalog's and ticketing's studio routes until auth slice B,
and ticketing's commerce routes and payment webhook until a real payment adapter is bound. Until
then ticketing's API does not boot in production at all: `PaymentsModule` refuses to bind the fake
provider there, which confirms every intent without taking any money.

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

Then start `identity` (port 3001), `notifications` and the storefront BFF (port 3003), and sign up
through the BFF, in bearer mode so the session comes back in the body:

```bash
curl -X POST http://localhost:3003/v1/auth/sign-up \
  -H 'content-type: application/json' \
  -H 'x-arthome-surface: storefront_web' \
  -H "idempotency-key: $(uuidgen)" \
  -H 'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' \
  -d '{"email":"marie@example.test","password":"a-long-password","mode":"bearer","acceptedTermsVersion":1,"locale":"fr"}'
```

What should then be true, and what is worth checking because each step can fail quietly:

| Where | What you should see |
| --- | --- |
| `identity.outbox_event` | two rows, `aggregateid` = the account id: `identity.account.registered.v1` (`aggregatetype = identity.account`) and `identity.email_verification.requested.v1` (`identity.email_verification`, a topic of its own: it carries the link's token, which `notifications` alone may read) |
| `identity.profile`, `device`, `device_session` | one default `adult` profile; one device (`desktop`, `unknown` while the BFF sends no `device`) holding its token's digest only; one open binding naming the better-auth session, without which the session resolves to nothing |
| topic `arthome.identity.account` | one message, **key = the account id**, so one account stays ordered; the token's message is on `arthome.identity.email_verification`, whose production ACLs `infra/kafka/README.md` requires |
| its headers | all five: `message-id`, `type`, `traceparent`, `actor-id`, `occurred-at` — the traceparent being the one the request carried. Debezium renders a NULL column as the four characters `null`, not as an absent header |
| `notifications.welcome_email` | one row, holding that same traceparent; nothing reads the verification topic yet |
| replaying the message | the consumer says `duplicate` and the row count does **not** move |
| signing out (`POST /v1/sessions/revoke`) | one `identity.device_session.closed.v1` on `arthome.identity.device`, key = the device id, `self_initiated` true: streaming ends that profile's leases on the device; a device revocation closes the caller's bindings on it, one close event each, and writes `identity.device.revoked.v1` once the last account holding it revokes it (`apps/identity/HANDOVER.md` §0c) |

