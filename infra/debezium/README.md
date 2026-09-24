# The Debezium outbox connector

`identity-outbox.json` is the connector that turns `outbox_event` rows into Kafka messages.
Register it against a running stack with:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  --data @infra/debezium/identity-outbox.json http://localhost:8083/connectors
```

## What the router maps

| outbox column | Kafka consequence |
| --- | --- |
| `aggregatetype` | the topic, via `arthome.${routedByValue}` |
| `aggregateid` | the **key**, hence the partition, hence the order of one aggregate |
| `id` | the `message-id` header — the consumer's deduplication key |
| `type` | the `type` header, used to route to a handler inside a multi-type topic |
| `tracecontext` | the `traceparent` header |
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
