## 0e. The events, and the availability publisher

- `date_sales.capacity_set` and `date_sales.pricing_changed` are outbox rows written by the command
  from the aggregate's uncommitted events (`date-sales-integration-events.ts`), in the order it
  applied them, on the date's key. `capacity_set` is written by `openCapacityTier` and by
  `setTechnicalProvision`, with `provisioned_capacity` once a provision is recorded, and again when
  a start moves the deadline of a provision required or recorded, so streaming provisions from one
  fact. It states `provision_revisable_until` only then, while a provision is required or
  recorded, so no event keeps a deadline a postponement left stale (correctness re-review); the
  pane serves the deadline whenever the date has a start.
- **`date_sales.availability_changed` is published at a bounded rate** (ADR §5), when the last
  publication is `AVAILABILITY_PUBLISH_MIN_INTERVAL_SECONDS` old, or at once when the date sold out
  or came back. The value published is core's `availabilityOf`; the SQL `seats_available = 0` only
  finds the candidates. A draft is never published.
- **A closing publishes a last time**, within the interval, offering no seat: `seats_available` 0
  and **not** sold out, so the cards and the index stop offering the date while no surface offers
  its waiting list. Sold out is what makes `decideWatch` offer `join_waitlist` (D-042 to D-044),
  and a waiting list on a cancelled date is a promise nobody can keep. Checked against core's
  `decideWatch`: its inputs carry no seat count, a cancelled date answers `date_cancelled` with
  `see_other_dates` before any seat action, and an interrupted one falls to the replay refusals,
  so nothing buyable is offered whichever way `waitlistOpen` reads.
- **The publisher never locks `date_sales`**, the row ADR §3 budgets for the hot decrement alone
  (both reviews, 2026-09-27). A move of what the event carries (a tier, a price, the opening, a
  closing, T3's holds) adds one to `date_sales.availability_moves`, in the statement that makes it.
  The publisher's bookkeeping is its own table, `date_availability_publication`: the count it
  published, when, and whether sold out. A pass reads its candidates without a lock, then takes
  each date in a short transaction of its own, claiming the publication row `FOR UPDATE SKIP
  LOCKED`, reading the figures as committed and deciding again. A move committed after that read
  counts one more than what is recorded as published, so it is due again and none is lost.
  Measured (`publish-due-availability.itest.ts`, three runs): a hold on the last date of a
  hundred-date pass waits 1.2 to 1.3 ms, against 69 to 73 ms when the pass locked every row; the
  pass takes 230 to 300 ms, one transaction per date. A move during a publication held open
  does not wait for it. The suite proves both without a wall-clock bound since PT4 (§0q): the
  publication, or the pass part-way, held on an advisory lock, the move under `lock_timeout`.
- **A pass reads the sales on sale and the closings not yet published, nothing else** (correctness
  re-review): each branch through a partial index (`idx_date_sales_on_sale`,
  `idx_date_availability_publication_closing_due`), a closing flagging its publication row in its
  own transaction and its last publication clearing it. Measured over 50,000 closed dates of
  history, five idle passes: 1.2 to 1.6 ms, against 32 to 42 ms here (24 to 25 ms in the review)
  when every pass joined every date. **The bound holds only while sales end**: a date that ends
  without an outcome stays on sale until its end by time, thirty minutes after its start, closes it
  (§0l), and stays in the pass until then; one with no start has no end.
- **A date that cannot be published holds back no other** (correctness review): its failure is
  logged, its `failed_at` recorded, and it waits `AVAILABILITY_PUBLISH_RETRY_SECONDS` (10) before it
  is tried again, behind the others, still marked; a publication clears it. The delay stays below
  the capacity freshness transport.md §5.9 promises, since a transient failure is set aside the
  same way as a poison row.
- **It runs in the sweeper process, its own, on a one-second loop**, not in the consumer and not on
  BullMQ. The sweeper needs Postgres alone: in the consumer's process a Kafka outage would stop it
  at boot, and on a queue a Redis outage would; T3's hold expiry lives here and must return capacity
  through either (ADR §4: Redis down, correctness holds). A loop rather than `@Interval`
  (`nestjs-scheduling-events`): no overlapping passes, and `beforeApplicationShutdown` awaits the pass
  in flight. Every replica may run it; `SKIP LOCKED` hands each its own dates, and a missed tick
  loses nothing (`nestjs-queues`' Decide: the recurring work stays in the database it reads). A pass
  reads only the sales on sale and the pending closings (above).
- **A future publisher of `ticketing.subscription.changed.v1` must set `version`**, strictly
  increasing per account (core's field 10): streaming orders the subscription by it and treats a `0` as unversioned, ordered by `occurred_at`.

