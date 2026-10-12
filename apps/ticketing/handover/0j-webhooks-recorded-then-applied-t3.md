## 0j. Webhooks, recorded then applied (T3)

`POST /v1/payments/webhook` (`payments/payment-webhooks.controller.ts`), adr-ticketing.md §8 and
adr-payments.md §7.

- **Verified on the raw bytes**: `main.ts` bootstraps with `rawBody: true`, and the controller hands
  `request.rawBody` and the provider's signature header to `RecordPaymentEvent`, which asks the
  webhook port before anything parses them. A signature that does not cover the bytes is 401
  `api.unauthenticated`, nothing recorded; signed bytes that are no event, 400.
- **Recorded, answered at once**: `stripe_event_inbox` (`1790440700000-payment-event-inbox.ts`, the
  ADR's name), unique on the provider's event id, `ON CONFLICT DO NOTHING`: a duplicate answers 200
  like the first, since the provider retries until it gets a 2xx. The row keeps the signed bytes and
  the request's `traceparent`.
- **Applied by the payment worker** (`PaymentWorker`, a `SweeperLoop` in the API process, every
  second, 100 events a pass): `ApplyPaymentEvents` claims each row `FOR UPDATE SKIP
  LOCKED` in a transaction of its own, then its order before its hold, applies the fact forward only
  (a confirmation settles the payment as tx B does; an action or processing records the intent; a
  failure or a cancellation fails the order and gives its seats back; a refund made and a dispute
  are §0o's; anything else is kept and ignored), writes the order's events, and marks the row
  applied in that transaction. A duplicate or
  a fact behind the order's state changes nothing, and an event about no order of this service's
  (no `order_id`, or a kind it does not handle) is marked applied as nothing. A failure is retried
  after the consumers' delays (`RETRY_DELAYS_MS`: 5 s, 30 s, 5 min, with their jitter, in
  `retry_at`), then given up on: `dead_at`, the row and its bytes kept as their own dead letter, an
  error logged (adr-payments.md §7.4); an event naming an order this service does not hold is given
  up on at once. Re-reading the intent from the provider when in doubt (§7.3) is not built:
  forward-only ranks carry every case the fake plays. It pauses unless it is behind: it answers
  what it settled (applied, or given up on), not what it looked at, so a pass whose batch all
  failed waits the next tick instead of spinning.
- **The calls owed to the provider are the worker process's** (§0m). A refund owed and an intent's
  cancellation are facts the transaction that finds them writes (`order_refund`,
  `intent_cancel_owed_at`), and the worker's queues make them, each kind on its own delays
  (correctness re-review m-a). A refund owed is money held without a seat, so it outlasts a
  provider's incident: from 5 s, doubled up to an hour, until a day has passed
  (`REFUND_RETRY_DELAYS_MS`: 28 attempts over 18.4 hours, 22.1 at most with the jitter), the call
  being idempotent under its key. Every automatic attempt lands under `REFUND_RETRIES_WITHIN_MS`,
  23 hours, an hour inside the provider's key retention (Stripe keeps a key 24 hours, the review's
  S4): asked again past it, a partial refund could be made twice. An intent's cancellation is best effort and keeps the
  consumers' delays (5 s, 30 s, 5 min: four attempts within about 6 minutes). The schedule itself,
  the doubling, the jitter and the bound, is `@arthome-platform/messaging`'s (`doublingDelays`,
  `retryDelayAfter`, `attemptsAllowedBy`), the consumers' own: only the delays are ticketing's.
- **Why the webhooks stay in the API process**: applying one needs Postgres alone, which the API
  holds already; the provider calls need Redis, and are the worker's, so the API stays ready on the
  database alone and no request path calls Redis or waits on a refund.
- **An intent owed its cancellation again** (`orders/record-waiting-intent.ts`, correctness
  re-review N2): an intent the provider reports still waiting (tx B or its webhook) on an order that
  failed owes its cancellation again. The instant first owed is kept, set only when none was owed,
  and `intent_cancel_enqueued_at` and `intent_cancel_dead_at` are cleared: the relay enqueues a new
  job, its attempts anew, once the last one ended, made or given up on, while a job still pending
  reads the mark at its next attempt. A payment clears the mark, and a job that finds it cleared
  ends without a call.
- **The webhook route is anonymous** (`AllowAnonymous`: its signature is its authentication, and a
  provider holds no internal token), and refused in production with the commerce routes until a
  real adapter is bound.

