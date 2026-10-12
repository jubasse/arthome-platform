## 0r. The `included` replay accesses (RT1)

`src/replay-access/`; `1791700000000-replay-access.ts` (processes stopped). adr-replay §1 to §5.

- **The model.** `replay_window`, one row per date, is ticketing's copy of catalog's `Replay`
  (state, version, policy, `live_ended_at`, `closes_at`, `online_at`) with `granted_at` and
  `revoked_at`. `replay_access`, one row per seat (`seat_id` unique, references `seat`), origin
  `seat`, `granted_at`, and `revoked_at` with its `revocation_reason`, both set or neither. Keyed by
  seat, not account: the holder is read through the seat when access is decided, so a transfer or a
  profile change writes nothing here. No unit access, no subscription access, no event yet (§3).
- **Ordering.** The first fact of a date inserts its window; any later fact whose `version` is
  greater replaces its fields, one at or below it is `superseded` (with its claim committed).
- **The grant.** When the kept state becomes `pending` or `online`, nothing was granted, nothing
  revoked, and core's `grantsReplayOnLiveEnd(policy, windowHours, date_sales.outcome)` holds: one
  `INSERT ... SELECT` gives every `active` seat of the date one access, then stamps `granted_at`.
  The event carries `closes_at`, not the date's `replay_window_hours`: the hours are read back as
  `closes_at - live_ended_at`, which is how catalog computed `closes_at`. A first-seen `online`
  grants (its `pending` was overtaken on a retry topic); a first-seen `closed` grants nothing.
  `closed`, and `online` after a grant, change the window's fields only.
- **The revocation.** `withdrawn` stamps every unrevoked access of the date `replay_withdrawn`
  (through `idx_replay_access_date_live`) and the window's `revoked_at`. A stale `pending` arriving
  after it is superseded by the version, so it grants nothing.
- **Refused facts.** A message with no `closes_at`, a `version` of 0, or `online` with no
  `online_at` is dead-lettered at once, RC1 §6.6 setting all three: kept, an `online` with no
  `online_at` would grant accesses that are never valid.
- **Trace.** `RecordReplayState` carries the message's `traceparent`; nothing writes it yet, the
  playback wave's `granted`/`revoked` outbox rows will (PRD §13.3).
- **Validity, recorded here, computed by the playback wave**: an access is valid while it is
  unrevoked, its seat is `active`, and its window is `online` with `online_at <= now < closes_at`
  (adr-replay §4: no period of its own). So a seat refunded or cancelled after the grant, or during
  it, keeps a row that grants nothing; writing `seat_refunded` on it is the refund paths' job once a
  reader exists. A seat activated after the grant gets none: none can be, the sale closing thirty
  minutes after the start (§0l).
- **Exactly once and locks.** `claimMessage` in the fact's transaction; the unique `seat_id`
  (`ON CONFLICT DO NOTHING`) adds nothing on a replayed grant. The window's row first (inserted
  `ON CONFLICT DO NOTHING`, then `FOR UPDATE`), then the accesses. `seat` is read unlocked through
  `idx_seat_date_active` and `date_sales` unlocked; `seat_order` and `date_sales` are never locked.
  The seat foreign key takes `FOR KEY SHARE` on each granted seat, which only a delete or a key
  change of the seat waits on, and no path makes either: a refund's or a cancellation's update
  passes, and a grant passes a refund holding its order, the date and the seat (tested). Two facts
  of one date at the same time (a retry topic's beside the main topic's) run one after the other on
  the window's row: one grant, the higher version kept (tested both ways).
- **Measured** (`replay-access.itest.ts`): one fact's transaction granting 5,000 active seats
  took 221 to 292 ms at a load average of 7 to 12, 0.8 to 1.5 s at 16 to 22, and 1.1 s beside
  ticketing's whole integration suite at 40; the seat foreign key's checks are about a third of
  the grant's statement (EXPLAIN ANALYZE), kept for a money record's integrity. The budget is one second on a normal host; above it, the
  grant moves to a sweeper batch, as §0n's settlement. The suite proves the shape rather than a
  wall clock: 50 and 5,000 seats are granted in the same number of statements, with a 5 s smoke
  guard.

