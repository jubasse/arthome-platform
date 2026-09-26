# The Debezium outbox connectors

One connector per publishing service turns its `outbox_event` rows into Kafka messages:
`identity-outbox.json` and `catalog-outbox.json`. Register them against a running stack with:

```bash
for c in identity catalog; do
  curl -s -X POST -H 'Content-Type: application/json' \
    --data @infra/debezium/$c-outbox.json http://localhost:8083/connectors
done
```

⚠ **The two files differ in four fields and nothing checks that they stay that way:**
`database.dbname`, `topic.prefix`, `slot.name`, `publication.name`. The slot and publication names
must equal `outboxSlotName(<service>)` from `@arthome-platform/messaging`, which the readiness checks
query. Five more connectors are owed; at the third, generate them instead of copying.

⚠ **Registering is not the same as correcting.** A publication or a slot outlives the connector config
that created it, and Kafka Connect keeps a deleted connector's source offsets under its name. Before
registering a new one, check `_connect_offsets` holds no key for it and that the database has no
slot or publication yet — the catalog connector was registered that way, on an empty outbox, and
came up scoped on the first attempt.

## What the router maps

| outbox column | Kafka consequence |
| --- | --- |
| `aggregatetype` | the topic, via `arthome.${routedByValue}` |
| `aggregateid` | the **key**, hence the partition, hence the order of one aggregate |
| `id` | the `message-id` header — the consumer's deduplication key |
| `type` | the `type` header, used to route to a handler inside a multi-type topic |
| `tracecontext` | the `traceparent` header |
| `actor_id` | the `actor-id` header — the studio journal reads it (`data-model.md` §2.3) |
| `created_at` | the `occurred-at` header — the instant of the business fact, distinct from publication |
| `payload` | the value, transported as bytes and read by nobody in between |

## ⚠ There is no dead-letter queue on this connector, and that was verified, not assumed

`events.md` §1.4 names two reject mechanisms: Kafka Connect's native dead-letter queue for
**connector** failures, and `arthome.<context>.retry` / `.dlq` for **consumer** failures. The second
exists and is exercised. The first **does not apply here**: Connect implements
`errors.deadletterqueue.*` for SINK connectors only, and the outbox router is a SOURCE connector.

Setting the properties anyway is not harmless-looking, it is worse: Connect **accepts** them, and
Debezium **echoes them back** in the task configuration at startup, so the log reads as though a
dead-letter queue were configured. The topic is never created and nothing is ever written to it.
Confirmed on Debezium 3.0 by setting `errors.deadletterqueue.topic.name` and observing the topic
absent from `kafka-topics.sh --list` afterwards.

## So `errors.tolerance` stays at `none`

`all` would skip a record the converter cannot handle. On this table that means **losing a
business fact that is already committed** — the outbox row is the source of truth, and the
application never reads it back to notice the gap.

Failing loudly is the recoverable posture: the connector stops, the replication slot retains the
WAL, and the lag is measurable (`confirmed_flush_lsn`). ⚠ It is also the posture that fills a disk
if nobody looks — alert on slot lag, and never leave a stopped connector registered.

## ⚠ The publication is created `FOR ALL TABLES` unless you say otherwise

Both files now set `publication.autocreate.mode: filtered`. What follows is why, and what it cost
while it was missing: the default is `all_tables`.
When the publication does not exist, Debezium runs
`CREATE PUBLICATION <publication.name> FOR ALL TABLES;` — which needs **superuser**, and captures
every table in the database. `table.include.list` then filters at the connector, *after* logical
decoding: the rows are read off the write-ahead log and shipped into the Connect worker before being
discarded.

Two consequences, and the first hides the second:

- **It works in development only because `arthome` is a superuser** — it is the official image's
  `POSTGRES_USER`. A production connector user that is not superuser cannot register the connector at
  all, and the tempting repair is to grant superuser.
- **Every `account` write — email, `public_handle` — is decoded and transported** although nothing
  consumes it. `data-model.md` §7.3 reasons that `REPLICA IDENTITY DEFAULT` suffices "since there is
  neither an `UPDATE` nor a `DELETE` captured". That is true of `outbox_event` and false of the
  publication as actually created.

**So set `"publication.autocreate.mode": "filtered"`**, which creates the publication for the tables
matching `table.include.list` and needs ownership of that table rather than superuser.

One query settles it on a running stack, and it is the one that would have caught this:

```sql
SELECT pubname, puballtables FROM pg_publication WHERE pubname = 'arthome_identity_outbox';
SELECT * FROM pg_publication_tables WHERE pubname = 'arthome_identity_outbox';
```

`puballtables = t`, or more than one table, means the default won. Measured here on 2026-09-25 before
the fix: `puballtables = t`, and the publication carried `account`, `migrations` and `outbox_event`.

⚠ This is the same lesson as the dead-letter queue above, with a worse blast radius: **Connect
accepts a property, or silently supplies a default, and the log reads as though it were configured.**
Six more connectors will be copied from this file.
