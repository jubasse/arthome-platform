### When a message cannot be applied

Two reject paths, and they answer different questions.

| Failure | Example | What happens |
| --- | --- | --- |
| **permanent** | no `message-id` header, or one that is not a UUID; bytes that are not this schema | **dead-lettered at once**, `attempt: 0`, no replay |
| **transient** | database unavailable, lock, dependency down | retried after 5 s, 30 s, 5 min — each with jitter — then dead-lettered |

Anything unrecognised is treated as **transient**, deliberately: retrying a permanent failure costs
three attempts, while discarding a transient one loses the fact for good.

The retry and dead-letter topics are declared in `infra/kafka/topics.json`; `pnpm run provision:topics` creates them at the partition counts `events.md` §3 fixes. Not by hand and not by auto-creation — a second, hand-maintained source for the same fact is the parallel table this repository's own gate exists to refuse.

**Retry at ONE layer.** A client retry, the broker's own redelivery and this budget multiply:
three of each is twenty-seven attempts for one message, and an outage becomes an overload caused by
the retries. `@arthome-platform/messaging` is the single owner for business failures.

**A retry topic reorders one key's events.** Kafka's ordering holds per partition, and a message
that waits five minutes comes back behind later events for the same aggregate.

**`search-indexer` guards this.** `version_type: external_gte` on the OpenSearch write, with the
event's `occurred_at` in epoch milliseconds as the version, so an older event is refused by the index
rather than applied — and its read model (`show_projection`, `date_projection`) carries the same
condition per group of fields, so an update that overtakes a publication keeps its fields. Date
documents are versioned by a counter advanced under the date row's lock, since a show change moves
them too (`apps/search-indexer/HANDOVER.md` §0). Proven on the running stack on 2026-09-26, the first time the catalog half ran:
an event one hour older with a fresh `message-id` — which deduplication cannot catch — left the
document's `_version` and fields untouched, and the consumer reports it as `superseded`, not
`applied`. **`notifications` does not, and does not need to**: it handles one message type
and its effect is one row keyed by `account_id`, so there is no second event to arrive out of order.
**`catalog`'s checklist projection guards it the same way**: each fact carries the reporting
context's `occurred_at`, and the upsert refuses an older one (`superseded`). The next consumer that
applies two events whose order matters owes the same condition.

**The wait is held INSIDE the handler, and that is not an implementation detail.** KafkaJS resolves
a message's offset as soon as `eachMessage` **returns** — unconditionally, storing `offset + 1`. So
any mechanism that returns early and arranges to come back later (pause + `setTimeout` + `seek` is
the obvious one, and was here) commits past a message whose only copy is that retry record. A
restart, a SIGTERM deploy, an OOM kill or a reassignment inside the wait then drops a committed
business fact, silently — `seek` is a no-op once the partition has left the assignment, and the
replacement starts at `offset + 1`. On the third tier that window is five minutes wide, and it is the
window an incident creates. `waitUntilDue` therefore blocks in the handler, heartbeats every 3 s, and
**throws** on shutdown so the message is redelivered rather than committed and lost. The cost is
intended: the retry partition is held for the duration, which is what a retry topic is for.

**There is no dead-letter queue on the connector, and the logs will suggest otherwise.** Kafka
Connect implements `errors.deadletterqueue.*` for sink connectors only; the outbox router is a
source connector. It accepts the properties and Debezium echoes them back at startup, so the output
reads as though one were configured — the topic is never created. See
[`infra/debezium/README.md`](../../infra/debezium/README.md).

