## 0m. The worker process: every provider call on BullMQ (T4, PT0)

`src/worker.ts` and `src/worker.module.ts`; in `payments/`, `provider-call-queues.ts` and its
module, `owed-call-relay.ts`, `refund.processor.ts`, `intent-cancellation.processor.ts`,
`refund-ledger.ts`. adr-ticketing.md §8: "Each queue is rate-limited below the provider's API limit
and uses provider idempotency keys ... Retries are bounded, with backoff and jitter, then a DLQ row
and an alert." The fact stays in Postgres, written in the business transaction; a relay moves it
to the queue.

- **A fourth process, not the API** (T4's to decide, decided here). It alone holds Redis and calls
  the provider: the API stays ready on the database alone (docs/agents/event-path.md), a drain of refunds shares
  neither its event loop nor its replicas, and the sweeper stays on Postgres alone (§0e).
  `createApplicationContext(WorkerModule)`, warn and error logs, SIGTERM and SIGINT with
  `useProcessExit`; `BullModule.forRootAsync` on `readRedisUrl()`.
- **Two queues**, `ticketing-refunds` and `ticketing-intent-cancellations`, under the prefix
  `{ticketing}` (one hash slot on a Redis Cluster). Jobs `refund.v1` `{ refundId }` and
  `intent-cancellation.v1` `{ orderId }`: ids only, each attempt reads its row. **The provider keys
  stay as they were**: core's `refundIdempotencyKey`, `refund:{refundId}`, stored as text on the
  refund's row (`refund:{orderId}` for every D-082 refund owed before PR C's core, those this
  migration backfilled and those PR B's code owed until then), and
  `intentCancelIdempotencyKey`, `cancel:{orderId}`. BullMQ
  6 refuses a colon in a custom job id unless it has exactly three segments, which it then files
  among its repeatable jobs, so `jobIdOf(key)` makes the colons dashes: `refund-{refundId}`,
  `refund-{orderId}`, `cancel-{orderId}`. One key, one job id, both stable.
- **The schedules** are §0j's, carried by each job: `attempts` from `attemptsAllowedBy(delays)`, a
  custom backoff the worker answers with `retryDelayAfter(attemptsMade, delays)`, the delays from one
  injectable provider, `PROVIDER_CALL_SCHEDULES`, which a suite shortens. `@Processor`'s options
  are static, so each processor sets that backoff on its own worker and then starts it
  (`autorun: false`) at bootstrap. `removeOnComplete` and `removeOnFail`: the row is the record and
  the dead letter, and a job kept would block its id when a replay enqueues it again.
- **The rate limit**, a worker limiter per queue: 20 refunds and 5 cancellations a second,
  concurrency 5 each. Together Stripe's test-mode limit, a quarter of its live one: a cancelled
  date's 10,000 refunds drain in about eight minutes. Measured: 60 refunds took two seconds at
  least. Revisited with the Stripe adapter, whose 429 is its own (§2).
- **The relay** (`OwedCallRelay`, a `SweeperLoop`, every second, 500 a batch) is the outbox relay
  of the calls (`nestjs-event-driven` rule 2). Per kind and pass, one transaction claims the rows
  due `FOR UPDATE SKIP LOCKED`, adds their jobs (`addBulk`, the job ids from the keys), stamps
  `enqueued_at` at the clock's instant, and commits. Due: owed, neither made nor given up on, and
  never enqueued; for a cancellation, also enqueued longer ago than its schedule's span with its
  jitter plus an hour (about 1.1 h), which only a job Redis lost leaves. A refund enqueued that
  long ago (about 23.1 h) and unsettled is given up instead, its row dead and §0k's error logged
  (the dispute's, on a disputed order):
  enqueued again, it would be asked past the provider's key. This amends PT0's R5 for refunds
  (the review's S4, the lead's ruling): enqueuing a lost job again is an automatic retry, and no
  automatic refund attempt falls past the key. BullMQ
  ignores an id it already holds, so two relays racing, or a crash between the add and the commit,
  enqueue once (proven over 1,000 refunds, each job completed once). Each claim reads its partial
  index (`idx_order_refund_due`, `idx_seat_order_intent_cancel_due`; `relay-plan.itest.ts` over
  20,000 rows).
- **A fail-fast producer.** The relay adds through queues of its own on the same Redis
  (`failFastTwinOf`): no offline queue, one retry, a 2 s command timeout; the workers keep the
  shared connection, which waits for Redis. A pass first waits at most 2 s for that connection,
  before locking anything. With Redis down it fails within the timeout, rolls back, stamps nothing
  and logs. Its lock across the Redis call is the outbox relay's accepted one, bounded by the
  timeout and the batch.
- **The refund processor.** A row made, given up on or gone ends the job without a call. Otherwise
  `PaymentPort.refund({ intentRef, amount, idempotencyKey, refundApplicationFee: true })` (the
  commission goes back with the money, adr-payments.md §9) outside any transaction, then one
  transaction: the order under its lock, then its refund row, `SeatOrder.refundMade` (`refunded`
  once the refunds made reach the total, `partially_refunded` before, forward only), and
  `order.refunded` for this refund under the trace its row carries. The last attempt's failure marks
  the row `dead_at` and logs §0k's error, in `process()` before rethrowing. The one failure written
  from the worker's `failed` event is the one `process()` never sees, a job stalled past its bound
  (below): best effort, its row `dead_at` and the same error.
- **The intent-cancellation processor.** Nothing owed, a payment having cleared it, ends the job
  without a call. Otherwise `cancelIntent(ref, cancel:{orderId})`, then `SeatOrder.intentCancelled()`
  saved; the last failure marks `intent_cancel_dead_at` and logs.
- **The ledger and its seam.** `order_refund` (`1790441200000-provider-call-queues.ts`): an order
  holds its `refunds`, several from T4 on, each with its id, amount, reason, key, seat or none, when
  owed, the provider's ref and when made. PT1 and PT2 owe through `SeatOrder.oweRefund({ id, amount,
  reason, idempotencyKey, seatId }, now)`, on an order `paid` or `partially_refunded` alone, refused
  past `refundableLeft` (core's `refundableRemaining`: the total less every refund owed or made) with
  core's `assertRefundWithinRemaining`, 409 `refund.amount_exceeds_remaining`, and for nothing. It
  is idempotent, since PT1 and PT2 replay their commands: owed again with the same facts it answers
  the refund already owed, and its id or key owed with other facts is refused; the repository
  inserts `ON CONFLICT DO NOTHING` and compares, so no 23505 aborts the caller's transaction. Then,
  once the
  order is saved, `recordRefundTraceparent(manager, refundId, traceparent)` in the same
  transaction. The key is the caller's, core's `refundIdempotencyKey(refundId)`. D-082's is
  `oweUnseatedPaymentBack(reason, intentRef, now)` (§0k). The migration moved each order's one
  refund to a row under `refund:{orderId}`, the key the provider may already hold, the owed ones
  enqueued by the relay's first pass. Its `down` puts them back on the order, lossless while no
  order owes a second, and refuses while an unsettled refund is keyed otherwise than
  `refund:{orderId}`: the code before it would ask that refund again under a new key (the review's
  C-S1). One D-082 refund per order is held by the database too, `uq_order_refund_unseated`
  (`1790441300000`, unique on the order for `hold_expired_capacity_lost`), since its key is no
  longer the order's; PT1, owing a payment back as `date_cancelled` (D-097), widens it.
- **Lock order** (§0h): an order before its hold and its refund rows, the date's row last. The relay
  locks refund rows alone, or orders alone for cancellations, `SKIP LOCKED`, and waits on nothing; a
  processor or a payment waits on a relay's row lock until its commit, the Redis call's 2 s at most.
- **A stalled job runs again under the same key.** A worker killed mid-call leaves its job active
  with a lock nobody renews; BullMQ moves it back to wait (one stalled check per 30 s across the
  workers), and another worker asks the provider again under the same key, which refunds once
  (proven: two calls, one refund; stalled twice, three calls, one refund). Up to
  `PROVIDER_CALL_MAX_STALLED_COUNT` (5) times: BullMQ's default of one failed a second stall before
  any attempt ran, so no `process()` marked the row, which waited the stale window in silence (the
  review's B1). Past the bound, the next worker fails the job unrun, and its `failed` event marks
  the row dead and logs the error, so `provider_calls_dead` and §0k's replay see it (proven with six
  stalls). §2's provider timeout below a claim's lease goes: a job's lock is
  renewed while its worker lives, the timeout bounds a job and the grace period covers it.
- **Shutdown** (`nestjs-queues` rule 7): each processor closes its worker in
  `beforeApplicationShutdown`, waiting for the jobs in flight, where the relay's pass in flight is
  awaited too; the queues and the pool close after (the boot suite, a call in flight at SIGTERM).
- **Redis down.** Purchases, webhooks, the expiry and the closing of sales go on, on Postgres; each
  call owed waits as a row; the relay fails each pass within its timeout, and drains each call once
  Redis is back (proven with Redis paused). `pnpm run ops:check ticketing` reports
  `provider_call_queues` (Redis ready, then each queue's waiting, delayed and active counts),
  `provider_calls_dead` (§0k), and `provider_calls_waiting`: degraded when a call has been owed
  longer than `PROVIDER_CALL_ENQUEUE_BOUND_MS` (a minute) and never enqueued, which no running relay
  leaves. It covers a worker down or crash-looping, a relay failing every pass, and the relay's
  producer left broken: BullMQ 6.3.9 keeps a connection's first failed start (its `INFO` past the
  2 s timeout) until the process restarts, read in its source and not reproduced, while
  `provider_call_queues` opens a connection of its own and answers up (the review's S3).
- **Two windows the stale window closes.** A last failure whose `dead_at` write fails, the database
  down too, leaves its row enqueued and unsettled: a refund is given up a schedule's span later, a
  cancellation enqueued again. An intent owed again in the instant its last job completes can wait
  the same 1.1 h. Neither loses a call.

