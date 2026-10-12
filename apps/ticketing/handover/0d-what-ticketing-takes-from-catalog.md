## 0d. What ticketing takes from catalog

`src/date-sales/catalog-date-messages.ts` reads `arthome.catalog.date` into two commands,
`ApplyCatalogDateFact` and `RecordReplayState` (§0r), whose handlers claim `processed_message` in
their transaction.

| Type | Fact | Effect |
| --- | --- | --- |
| `catalog.date.drafted.v1` | `drafted` | opens the `DateSales`; a second draft of the date is `superseded` |
| `catalog.publication.engaged.v1` | `lock`, when it engages the prices | locks them, opens the sale, restates `pricing_changed` |
| `catalog.date.scheduled.v1`, `.rescheduled.v1` | `start` | records the start and moves the active seats' cancel deadline with it (§0n); restates `capacity_set` when the deadline of a provision, required or recorded, moves |
| `catalog.date.outcome_declared.v1` | `outcome` | records it; `cancelled` and `interrupted` close the sale (ADR §8) and write the date's settlement row, which the sweeper settles: refunds or credits (§0n) |
| `catalog.replay.state_changed.v1` | `RecordReplayState`, its own command | keeps the date's `replay_window` by the `Replay`'s version; grants the `included` accesses at `pending` (or a first-seen `online`), revokes them at `withdrawn` (§0r) |

Anything else is `ignored`, and so is an outcome, a replay state or a replay policy member this
build does not know (critical rule 10).
**A fact about a date not opened here is retried, not dead-lettered**: catalog drafts first, so only
a retry topic holding the draft explains it, and the draft is ahead of it on their key's retry
partition. Unreadable bytes, a missing or malformed `message-id`, and a replay fact without `closes_at` or
`live_ended_at` are dead-lettered at attempt 0.
A draft older than the topic's retention is never read: see the deployment order (§0).

