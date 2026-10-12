# One malformed outbox row kills the connector, and recovery is not obvious

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

> **Do NOT drop the replication slot.** It looks like the decisive fix and it loses data: Debezium
> then recreates the slot at the CURRENT WAL position and every row not yet published is skipped for
> ever, sitting in the outbox that nothing reads back. Done here by accident, and the events were
> gone.

**Which is why the constraints exist.** `@arthome-platform/messaging` defines the outbox table with
CHECK constraints — topic-safe `aggregatetype`, non-empty `aggregateid`, versioned `type`, non-empty
`payload` — so the row cannot be committed in the first place, and the business operation is refused
inside the transaction, where a request is still waiting to be told.

**A replication slot nobody consumes retains the write-ahead log.** Stopping the connector and
leaving it registered makes the disk grow until it is full (`data-model.md` §7.4). `docker compose
down -v` removes everything, slot included.

