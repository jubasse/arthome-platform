## 0q. The race suite and the drills (T4, PT4)

adr-ticketing.md §12's races and failure drills, on real Postgres, Redis, Kafka and Debezium from
`libs/testing`, each file on a database of its own, every outage a `docker pause` restored in
`finally`. No suite asserts a wall-clock bound: a wait is held on an advisory lock the suite holds
(`src/itest/locks.ts`) and seen in `pg_stat_activity`, and retries run on shortened schedules.

- **The races** (`orders/refund-races.itest.ts`, `payments/chargeback.itest.ts`), 20 orders at once
  each through `Promise.allSettled`, a loser's refusal named, then the ledger
  (`src/itest/race-ledger.ts`): available, held and sold seats adding up to the capacity, one `seat`
  row per seat sold, no order refunded above what it paid, and for every refund row, made or not, a
  refund at the provider under its key, of the row's amount, exactly when the row is made. Calls
  per key are not counted: a refund webhook asks the call again under the same key (R15).
  - A date's cancellation against 80 payments confirmed before it, with it, during its settlement
    and after it (past their holds): every order refunded once, in full, `date_cancelled`, none left
    `paid`, every seat `refunded` after one `seat.cancelled` `DATE_CANCELLED`, no seat for the late
    ones. Late payments alone the same, never `hold_expired_capacity_lost`. The 20 paid with the
    cancellation are applied while its transaction is held open before it locks the date, then race
    its commit: 7 of 20 seated before it, three runs out of three, bounded above 0 and below 20. The
    20 paid during the settlement all see the cancellation: no race with the enumeration, which
    `late-payment.itest.ts` covers.
  - Two paths to one refund: the date's refund job against duplicated successes applied by two
    workers, for orders paid before and orders seated by the payment itself: one call, one
    `order.refunded`. And R15's path: 20 refunds made at the provider, their answers lost, their
    `refund_succeeded` applied by four workers while four relay passes run their jobs: one refund
    per key, each row made with the provider's ref, one `order.refunded`. At the race's end, five
    runs: all 20 webhooks applied, 0 to 20 rows made, 2 to 20 reruns still asked.
  - A viewer's `cancelSeat` and the studio's partial `refundSeat` racing the date's refund, a relay
    pass in the race: the paid total refunded once, each seat cancelled once. The race only plays
    the command first: viewer first then after the fact 13/7 to 15/5, the studio first 20/20, the
    settlement first never, since the commands take the pool before the date's settlement runs.
    That order is forced in a case of its own per command: the settlement held on its
    `seat.cancelled` insert with the order locked, the command seen waiting on the order's row,
    then refused `seat.not_active`, one `date_cancelled` refund of the paid total. **Found and fixed**: a cancellation committed
    between `cancelSeat`'s read of the date and its counter move gave the seat back to sale on a
    cancelled date, refunded `viewer_request` (§0o, the PT2 review's m3).
  - Chargebacks: a dispute and its duplicate; one before its confirmation; one before or after a
    cancelled date's refund, the refused refunds given up within their bound and counted apart by
    `provider_calls_dead` (§0k, F2); a refunded order disputed; a viewer's cancellation on a
    disputed order. Never a second refund, nothing on the viewer's side.
- **Provider down** (`drills/provider-down.itest.ts`, about 5 s of outage on a 1/4/8/8 s schedule):
  a purchase 503 with its hold released; 50 refunds and 15 intent cancellations each tried again,
  none dead, then each made once; the limiters held at their limit: BullMQ's fixed windows rebuilt
  from each job's `processedOn` (a window opened by the first job started once the last closed),
  the busiest started exactly 20 refunds and 5 cancellations, three runs out of three; a refund
  refused for good dead after its five attempts, then replayed once.
- **Redis down** (`drills/redis-down.itest.ts`, about 22 s): purchases, the expiry, the publisher
  and the settlement on Postgres alone, readiness up, 30 refunds owed, the relay failing fast and
  stamping nothing; Redis back, the same worker makes each call once.
- **Kafka down** (`drills/kafka-down.itest.ts`, 30 s, the connector registered from
  `infra/debezium/ticketing-outbox.json`): purchases, a seat's cancellation and a publication commit
  and readiness stays up; once Kafka is back every outbox row reaches its topic in commit order per
  key, a consumer claiming by `message-id` applies each once (redeliveries happen), and the catalog
  consumer, never restarted, applies a cancellation produced after it and answers its redelivery
  `DUPLICATE`. **Found, fixed**: past the Connect worker's session the
  broker, resuming, may evict it, and its connector then waited Connect's
  `scheduled.rebalance.max.delay.ms` (five minutes by default) before it was assigned again: the
  last row arrived 1.5 s, 300.9 s and 302.5 s after the resume over three runs. The delay is now
  20 s (`CONNECT_SCHEDULED_REBALANCE_MAX_DELAY_MS`) in `compose.yaml` and in the test harness, a
  spec keeps the two equal, and the drill waits 140 s for the last row (20 s plus 120 s of margin).
- **The flaky timings made causal**: `publish-due-availability.itest.ts`' three (§0e) and
  `expire-due-holds.itest.ts`' skip (§0i). The publisher's suite passed 20 runs in a row
  while ticketing's whole integration suite (37 files) ran beside it, the load average at 25 to 54
  during the overlap and down to 5 by the last run.
- **Two settlement fixes** (the PT1 review): a date waiting on a hold alone no longer takes a
  pass's slot (§0n, F1), and both guards of nothing left in `order-outcome.ts` are pinned (F3).
  `provider-call-queues.itest.ts`' 1,000-refund race read a job's `completed` event before it
  fired, the refund row being committed first: test timing, not a missed enqueue.

