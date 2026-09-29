# `ticketing` — handover: a date's commercial face (T2), its holds, orders and payment (T3)

arthome-core `adr-ticketing.md` (accepted, D-077 to D-083) cuts the first slice into phases. T2 built
the service itself and `DateSales` (`data-model.md` §3.1), §0 to §0f; T3 the holds, the orders and
their payment, §0g onwards. Outcomes and refunds are T4, the waiting list T5, the waiting room T6,
the BFF routes T7. Everything below was run, against real Postgres and Kafka through
`libs/testing`, not reasoned about.

## 0. Three processes, one database

| Process | Entry | Serves |
| --- | --- | --- |
| API | `node dist/main.js`, `PORT` (3004 in `.env.example`) | the studio's `setDatePrices`, `openCapacityTier`, `setTechnicalProvision`, `getDateTicketsPane`; the storefront's `refreshDateAvailability`, `quoteSeat`, `purchaseSeat`, `getOrder` (§0h); the provider's webhooks and the payment worker (§0j, §0k); `/health/liveness`, `/health/readiness` |
| consumer | `node dist/consumer.js` | `arthome.catalog.date`, retrying on `arthome.ticketing.retry`, dead-lettering to `arthome.ticketing.dlq` |
| sweeper | `node dist/sweeper.js` | the availability publisher (§0e), the hold expiry (§0i) and the closing of sales whose time is over (§0l), Postgres alone |

**Stop all three before `migration:run`.** A migration may drop a column the running build still
reads (`1790440100000` moved three `date_sales` columns to the publisher's table): a rolling restart
would fail their reads, and the consumer could dead-letter facts it can no longer apply.

All three read `DATABASE_URL` through `libs/config` (`NODE_ENV` required, never defaulted), close
their pool on SIGTERM, and are booted as their entry points boot them by `src/boot.itest.ts`. The API
binds `DenyInProductionGuard`, the envelopes and the validation pipe through
`@arthome-platform/http-edge`'s `edgeProviders` (`src/edge-providers.ts`), as catalog does. Its readiness fails only on the database; the slot, the publication and the outbox
retention answer `degraded`.

**Deployment order: ticketing's consumer runs before the first date is drafted in production**
(both reviews, 2026-09-27). A sale opens only from `catalog.date.drafted`, and the consumer group
reads `arthome.catalog.date` from the beginning of what the topic keeps (168 h). A date drafted
longer than that before the group first reads it never opens: every later fact about it is
retried, then dead-lettered, and its checklist can never be satisfied. Nothing restates old drafts;
a catalog migration restating `DateDrafted`, and the start and lock of published dates, the way
`PublicSlugs1790420900000` restated `DateScheduled`, is the way back if it happens. On the
development stack the backlog was within the retention and opened every date drafted before.

## 0a. `DateSales`

`src/date-sales/date-sales.aggregate.ts`, one row of `date_sales` (`1790440000000-initial.ts`).

- **Capacity** opens by tiers (`openCapacityTier`, the first one included) and widens through core's
  `assertTierWidens`; nothing shrinks it. Each tier is kept with its id, size and instant.
- **The counters** `seats_available`, `seats_sold`, `waitlist_count` are written by the repository
  **as deltas** from what it loaded (`seats_available + n`), never as values: T3's conditional
  decrement moves them without the version (ADR §11). A CHECK refuses a negative counter and one past
  the capacity; the decrement's WHERE stays the rule.
- **Prices** are replaced whole until the sale opens, then refused `date.prices_locked` with
  `lockedAt`. The sale opens when `catalog.publication.engaged` names the prices; `on_sale` is a
  column Postgres generates from the lock and the close, for T3's WHERE.
- **The technical provision** (D-088) is `technicalProvisionOf` (`technical-provision.ts`): core's
  threshold and `requiresTechnicalProvision`, the capacity the studio's recorded provision covers,
  and core's `provisionRevisableUntil` whenever catalog has stated a start. `setTechnicalProvision`
  records or revises it through core's `assertTechnicalProvisionRecordable`: refused 409
  `date.provision_deadline_passed` from the deadline on, `date.provision_below_capacity` below the
  capacity already open. `openCapacityTier` passes it to core's `assertTechnicalProvisionCovers`: a
  capacity past the threshold it does not cover is refused 409 `date.technical_provision_required`,
  naming the threshold, the capacity asked for, the provision and the deadline.
- **One currency per sale** is core's `assertPricesShareCurrency`, called by `setPrices`: 409
  `date.prices_currency_mismatch`, naming the stray tier, its currency and the expected one.
- **The version** counts every load-modify-save, a studio command's or a consumed fact's: a studio
  screen that did not see a reschedule or the lock is stale like any other (accepted by the lead,
  2026-09-27). A command names it (`expectedVersion`); a fact is guarded by its own `occurred_at` per
  group (the start, the outcome), and the lock happens once. Events are stated at ticketing's clock,
  catalog's instant kept only as the guard, so a skew between the two cannot reorder one stream.

## 0b. The studio's operations

`PUT /v1/dates/:dateId/prices`, `POST /v1/dates/:dateId/capacity-tiers`,
`PUT /v1/dates/:dateId/technical-provision` and `GET /v1/dates/:dateId/panes/tickets`, in
`openapi/studio.yaml`'s shapes.

- The three commands take an `Idempotency-Key` (`runIdempotentlyVersioned`: the version at the
  envelope's root), answer the pane read off the row inside their transaction, and refuse 409 with
  the domain's code: `state.conflict` with `version`, `date.prices_locked`,
  `date.prices_currency_mismatch`, `capacity.tier_must_widen`, `date.technical_provision_required`,
  `date.provision_deadline_passed`, `date.provision_below_capacity`.
- `setDatePrices` refuses 400 naming `tiers` a tier sent twice: a malformed body. Two currencies
  are a well-formed body a rule refuses, 409 above.
- `openCapacityTier` accepts `notifyWaitlist` and records nothing for it: the waiting list is T5's.
  It answers `waitlistNotified: 0`, true while no list exists, and no `priorityUntil`. On a sale a
  cancellation or an interruption closed, it refuses 409 `state.conflict` naming the version and
  the outcome.
- **The pane** is `DateSalesPaneSchema`'s, parsed in the suites. Absent: `serviceFeePerSeat` and
  `replayUnitPrice` (no schedule is set anywhere), `complimentaries`, the penalty exposure (no rule
  in core), `grossRevenue` (it needs `canRevenue` and a sale). `promotions` is empty.
- A date ticketing has not opened yet is 404: the studio can reach the pane a moment before the
  consumer reads `catalog.date.drafted`.

## 0c. The storefront's `refreshDateAvailability`

`GET /v1/dates/:dateId/availability`: seats available, waiting list, fill rate, sold out, the price
tiers, read live off the row, each through core (`date-sales-figures.ts`, which the pane and the
event share). It requires `x-arthome-deadline`, answers `no-store` (the BFF sets `public,
max-age=15`, the operation's freshness, transport.md §5.9), and carries core's
`availabilityValidUntil`, `AVAILABILITY_VALID_SECONDS` after `servedAt`. **Only a sale on
sale is served** (`on_sale`): before it opens, and once a cancellation or an interruption closed it,
the read answers 404 rather than seats nobody can buy.

## 0d. What ticketing takes from catalog

`src/date-sales/catalog-date-messages.ts` reads `arthome.catalog.date` into one command,
`ApplyCatalogDateFact`, whose handler claims `processed_message` in its transaction.

| Type | Fact | Effect |
| --- | --- | --- |
| `catalog.date.drafted.v1` | `drafted` | opens the `DateSales`; a second draft of the date is `superseded` |
| `catalog.publication.engaged.v1` | `lock`, when it engages the prices | locks them, opens the sale, restates `pricing_changed` |
| `catalog.date.scheduled.v1`, `.rescheduled.v1` | `start` | records the start; restates `capacity_set` when the deadline of a provision, required or recorded, moves |
| `catalog.date.outcome_declared.v1` | `outcome` | records it; `cancelled` and `interrupted` close the sale (ADR §8), refunds and credits T4 |

Anything else is `ignored`, and so is an outcome member this build does not know (critical rule 10).
**A fact about a date not opened here is retried, not dead-lettered**: catalog drafts first, so only
a retry topic holding the draft explains it, and the draft is ahead of it on their key's retry
partition. Unreadable bytes and a missing or malformed `message-id` are dead-lettered at attempt 0.
A draft older than the topic's retention is never read: see the deployment order (§0).

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
  pass takes 230 to 300 ms, one transaction per date. A move during a publication held open 300 ms
  does not wait for it.
- **A pass reads the sales on sale and the closings not yet published, nothing else** (correctness
  re-review): each branch through a partial index (`idx_date_sales_on_sale`,
  `idx_date_availability_publication_closing_due`), a closing flagging its publication row in its
  own transaction and its last publication clearing it. Measured over 50,000 closed dates of
  history, five idle passes: 1.2 to 1.6 ms, against 32 to 42 ms here (24 to 25 ms in the review)
  when every pass joined every date. **The bound holds only while sales end**: a date that ends
  without an outcome stays on sale until its end by time closes it (§0l), and stays in the pass
  until then: while no rule gives that end, it stays for good.
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

## 0f. Conventions

Catalog's, `apps/catalog/HANDOVER.md` §0f, through the same libraries: `TicketingTransactions` is
`TransactionRunner` over `ticketingTransactionOf`, the repository tracks with `AggregateTracker` and
saves with `saveVersioned`, commands answer through `runIdempotentlyVersioned`, consumers claim with
`claimMessage`. Domain events reach the `EventBus` after the commit and nothing subscribes to them.
Refusals: the aggregate throws core's `DomainError`; the studio handlers wrap it in `asConflict`
(409), the consumer maps it (retry for an unknown date, dead-letter otherwise).

T3's `SeatHold` and `SeatOrder` follow them, `TicketingTransaction` carrying `holds` and `orders`
beside `dateSales`, with three departures, each for a reason stated where it is built: the purchase
runs in two transactions with the provider between them (§0h), the sweeper's expiry is set-based
SQL over its batch rather than one aggregate per row (§0i), and the purchase is keyed on its order
rather than `runIdempotently` (§0h). The storefront's handlers throw `RefusalException`, reached
from HTTP alone; the payment worker's, reached from no request, log a failure and leave it due.

## 0g. The payment ports (T3)

`src/payments/payment.port.ts` holds `adr-payments.md` §4's ports until core carries them (§3):
`PaymentPort` (`createIntent`, keyed by the order id, `cancelIntent`, `refund`, keyed
`refund:{orderId}`) and `PaymentWebhookPort` (`verifySignature` on the exact bytes, `parse`). The
names are `adr-ticketing.md` §2's (`createIntent`), where §4 of the payments ADR sketches
`authorize`. A provider's references are opaque strings; `PaymentProviderUnavailable` says the
provider could not say what it did, so the caller retries under the same key.

`FakePaymentProvider` is the adapter bound by default (`payments.module.ts`), both ports on one
instance, since a webhook speaks of the intents it created. Deterministic: an intent's reference is
derived from its order id, event ids are counted, and each intent plays `scenarioOf(request)`:
`confirm` (the default, confirmed synchronously), `require_action` (then `completeAction` or
`failAction` hands back the signed webhook saying how it ended), `decline`, `unavailable`. `down`
makes every call fail, the provider-down drill. Its signature is Stripe's scheme on its own header,
`x-fake-payment-signature: t=<seconds>,v1=<HMAC-SHA256 of "t.body">`, refused past adr-payments.md
§7.1's five minutes. The secret is `PAYMENT_WEBHOOK_SECRET` (`@arthome-platform/config`'s
`readPaymentWebhookSecret`), defaulted outside production only, 32 characters at least.

## 0h. Holds, orders and the purchase (T3)

`src/orders/`: `SeatHold` and `SeatOrder` (`data-model.md` §3.2, §3.3), their tables in
`1790440500000-holds-and-orders.ts`, and the storefront's `quoteSeat`
(`POST /v1/dates/:dateId/seat-quote`), `purchaseSeat` (`POST /v1/orders/seats`) and `getOrder`
(`GET /v1/orders/:orderId`), in storefront.yaml's shapes but for `TicketCard.date` and the 201's
`date`: catalog's `DateCard`, which ticketing cannot build without calling catalog (critical rule 1),
so the BFF adds them (T7, agreed with the lead). The HTTP suite parses the tickets with the
contract's `TicketCardSchema` minus `date`. The two reads require `x-arthome-deadline`, as `refreshDateAvailability`
does; the three answer `no-store`.

- **The purchase is adr-ticketing.md §2** (`purchase-seat.handler.ts`). Tx A binds the key to a new
  order, verifies the price, takes the seats with the one conditional decrement, inserts the hold
  (checkout, expiring with its intent: core's `checkoutIntentExpiry`) and the order, pending, its
  quote frozen. Outside any transaction, `PaymentPort.createIntent`, keyed by the order id. Tx B
  applies what the provider said, forward only; confirmed, `settleConfirmedPayment` consumes the
  hold, moves `seats_sold`, draws the seat codes and pays the order, which writes `order.paid` on the
  order's key, then one `seat.activated` per seat on the date's (D-077, D-078). It answers 201 with
  the tickets and the order, 202 with the `PaymentHandoff` (its `expiresAt` the hold's), 409
  `order.payment_declined` with the provider's `declineCode` (hold released, seats back), or 503
  `api.service_unavailable`. A route cannot declare two statuses: the controller sets the command's
  through `@Res({ passthrough: true })`, which keeps the envelope and the replay header.
- **The hot row is never locked on this path.** `DateSales` is loaded by `findUnlocked`, decides the
  hold (`holdSeats`, which moves its counter and not its version), and the repository's `takeSeats`
  runs §2's statement below, registered with `writtenUnversioned`, the stored snapshot moved by the
  same amount so a save later in the transaction measures no delta. `seats_sold` moves at payment by
  `sellHeldSeats`, a hold given back by `returnHeldSeats`; each counts its move on
  `availability_moves` in its own statement.
- **Idempotency is the order's** (libs review L1): this route writes no `idempotency_record`. Tx A
  claims the key with `INSERT … ON CONFLICT DO NOTHING` on `seat_order_idempotency` before the
  decrement, so a second attempt waits on the key, never on the date's row, bounded at five seconds
  (then `api.idempotency_in_flight`). A replay reads the order: an answer kept (201 or 202, in a
  `json` column, so byte for byte) is served again with `Idempotency-Replayed`; an order left pending
  with no intent, a crash between A and B, resumes: `createIntent` again, the provider handing back
  the intent it created under the order id, then tx B; an order that ended unpaid answers from its
  state, the decline, else sold out. A refusal of tx A rolls the order back with the rest, so the key
  stays free. Another body under the key: 409 `api.idempotency_key_reused`. Two attempts at once
  get one order and one answer, the second kept answer served to both.
- **The provider down** (adr-ticketing.md §12's drill) releases the hold, gives the seats back and
  answers 503, and the order stays pending, bound to its key: a retry under the same key resumes it,
  holds the seats again (a new hold, the first `released`) or fails it sold out, and asks the
  provider under the same order id, so a charge the provider made before timing out cannot be made
  twice.
- **Lock order:** an order before its hold, everywhere; the date's row last. **The counter
  statement is the last of its transaction** (review M2), so the hot row is locked for the commit
  alone, as adr-ticketing.md §2 budgets: tx A inserts the hold and writes its events before its
  decrement; tx B and the webhook worker are handed the payment's or the failure's counter move
  (`PendingCounterMove`) and run it after the seats, the outbox rows and the kept answer. Two
  statements still run early, each because its result decides what follows: D-082's
  `takeAndSellSeats` (pay or owe a refund) and a renewed hold's `takeSeats` (hold again or fail sold
  out), both off the normal path.
- **The price** is core's `quoteSeats` over the date's own tier price (`date-sales/seat-quote.ts`),
  the rule `quoteSeat` serves and `purchaseSeat` verifies `expectedTotal` against: 409
  `order.price_stale` with `expectedAmountMinor`, `currentAmountMinor` (absent for a tier not sold)
  and `currencyCode`. With no promotion stored, no subscription known and no fee schedule set, a
  quote has its tier line alone. `quoteSeat` answers 404 for a date not on sale or a tier it does not
  sell; `purchaseSeat`, whose contract has no 404, answers `order.sold_out` for a date not on sale,
  as its statement does past the seats left.
- `contributionMinor` and `applyCreditId` are accepted as null alone, 400 naming the field
  otherwise: neither has a rule yet, and no money is taken on a field ignored.
- **A seat's code** is core's `seatCode` over six characters drawn with `crypto.randomInt`, each
  looked up and drawn again when taken (`seat-codes.ts`): at a hundred thousand seats a handful
  would collide, and the unique constraint alone would abort the payment.

## 0i. Holds expire in the sweeper (T3)

`orders/expire-due-holds.handler.ts`, adr-ticketing.md §6, run every second by `HoldExpirySweeper`
beside `AvailabilityPublisher` in the sweeper process, which stays on Postgres alone. Both loops are
`SweeperLoop` (`src/sweeper-loop.ts`), the publisher's loop lifted as it was: no overlapping passes,
the pass in flight awaited at shutdown, the next one at once after a full batch.

- **A pass is one transaction, set-based**: up to 500 expired active holds, joined with their
  orders, `FOR UPDATE OF hold, placed SKIP LOCKED`. A hold whose order a payment holds is skipped,
  left to that payment, which consumes it or takes the seats again (D-082), and the pass never waits
  on a lock a payment could be waiting behind: the purchase and the webhook lock an order before its
  hold, the pass takes both or neither. Each hold is `expired`, its order `failed` if it still waited
  for its payment, and the seats go back by `returnHeldSeats`, one statement per date in `date_id`
  order, the dates' rows last, each counting a move for the publisher.
- **A pass also fails an order still pending past its expiry with no intent and no active hold**:
  the provider did not answer, the hold went back (§0h), and nobody retried the purchase. Its own
  partial index, `1790440600000-pending-order-expiry.ts`.
- **Cancelling the intent at the provider is recorded, not called** (decided in T3): an order that
  fails holding an intent gets `intent_cancel_owed_at`, and the sweeper calls no provider, so a
  provider outage cannot slow the pass that returns capacity, and the process keeps its one
  dependency. The cancellation is best effort either way (§6): a confirmation already in flight
  arrives as a late payment, §0k.
- Measured nothing yet: the expiry's cost under load is T6's load test.

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
  second, 100 of each kind of work per pass): `ApplyPaymentEvents` claims each row `FOR UPDATE SKIP
  LOCKED` in a transaction of its own, then its order before its hold, applies the fact forward only
  (a confirmation settles the payment as tx B does; an action or processing records the intent; a
  failure or a cancellation fails the order and gives its seats back; anything else is kept and
  ignored), writes the order's events, and marks the row applied in that transaction. A duplicate or
  a fact behind the order's state changes nothing, and an event about no order of this service's
  (no `order_id`, or a kind it does not handle) is marked applied as nothing. A failure is retried
  after the consumers' delays (`RETRY_DELAYS_MS`: 5 s, 30 s, 5 min, with their jitter, in
  `retry_at`), then given up on: `dead_at`, the row and its bytes kept as their own dead letter, an
  error logged (adr-payments.md §7.4); an event naming an order this service does not hold is given
  up on at once. Re-reading the intent from the provider when in doubt (§7.3) is not built:
  forward-only ranks carry every case the fake plays.
- **Every call owed to the provider is claimed, backed off and bounded** (`payments/owed-calls.ts`,
  review M1/M3): a refund owed and an intent to cancel each carry, beside the fact
  (`refund_owed_at`, `intent_cancel_owed_at`, never overwritten), `*_attempts`,
  `*_next_attempt_at` and `*_dead_at` (`1790441000000-provider-call-retries.ts`). A pass claims up
  to 100 due calls `FOR UPDATE SKIP LOCKED` in a short transaction that counts the attempt and moves
  the next one out by the same delays, so another replica's pass skips them and a crash mid-call
  leaves them due again later; the call itself runs outside any transaction. After the fourth
  failed attempt the call is given up on (`*_dead_at`) with an error logged. A call refused for
  good waits its delays like any other, so it never holds newer ones back.
- **The worker pauses unless it is behind**: each of its three commands answers what it settled
  (applied, refunded, cancelled, or given up on), not what it looked at, so a pass whose batch all
  failed waits the next tick instead of spinning.
- **Why the API process**: the worker calls the provider (a refund, §0k; a cancellation, below),
  which the API needs already, and the sweeper keeps Postgres as its one dependency. T4 moves the
  provider calls onto its queue (§2).
- **Cancelling an expired order's intent** (`CancelOwedIntents`, same worker): the orders the
  sweeper marked `intent_cancel_owed_at`, cancelled at the provider under `cancel:{orderId}`, the
  mark cleared, each attempt claimed as above. Best effort (§6): it narrows a late payment's window
  and cannot close it, and a payment clears the mark.
- **The webhook route is refused in production**, as every write here is, by
  `DenyInProductionGuard`; its signature is its authentication, and a real provider's adapter will
  want it exempted with the Stripe adapter, not before.

## 0k. A payment confirmed after its hold expired (T3, D-082)

`orders/settle-payment.ts`, shared by tx B and the webhook worker. A confirmation for an order that
can still take a payment consumes its hold while that hold is active, even past its instant if the
sweeper has not reached it. When the hold is gone (expired, released), the seats are taken again
by `takeAndSellSeats`: `seats_available - q` and `seats_sold + q` in one statement, conditioned on
`on_sale AND seats_available >= q`. The order is then paid as any other, its failure cleared and
its owed cancellation dropped.

With none left, the order owes the money back, `hold_expired_capacity_lost`, recorded in the same
transaction with the trace it was found under (`refund_traceparent`), no seat created, nothing
sold. Then, outside any transaction, `OwedRefunds.refund` asks the provider under
`refund:{orderId}` and marks the order `refunded` in a transaction after it, with `order.refunded`
(`refund_reason` `HOLD_EXPIRED_CAPACITY_LOST`, no seat cancelled) under that trace. The purchase
path and the webhook worker both ask at once, a first try the attempts do not count, so a refusal
leaves the refund due at once to `RefundOwedPayments`, whose claimed attempts back off and are
bounded (§0j); the key makes a second ask the same refund. Never an oversold date, never money kept
without a seat. `payouts` receives this `order.refunded` for an order it never saw `order.paid`.

A purchase replayed under its key once its hold expired, never having reached the provider,
answers `order.sold_out` from the failed order and asks the provider nothing.

## 0l. Seat sales end thirty minutes after the start, and a late buyer is told (T3, D-089)

`on_sale` had no end in time: a date ending without an outcome stayed on sale, sold after the show,
and in the publisher's pass for good (§0e). The product owner ruled (D-089, recorded in core by the
lead): **a seat covers the live alone** (a replay's access is a separate matter, out of T3), **its
sales end `SEAT_SALES_CUTOFF_MINUTES_AFTER_START` (30) minutes after the live's start**, the same
for every channel, and **a buyer arriving after the start is told what was missed and must
acknowledge it**. The rules are `date-sales/seat-sales-window.ts`'s `seatSalesEndAt(startsAt)` and
`lateEntryOf(startsAt, now)`, under the names core will give them (§3).

- **The end** is `date_sales.sales_end_at` (`1790440800000-sales-end.ts`), written by
  `recordSchedule` from `seatSalesEndAt` whenever catalog states or moves the start, so a
  postponement moves it; `1790440900000-seat-sales-cutoff.ts` backfilled it for the dates already
  scheduled.
- **The hold's statement refuses past the end by itself**: its WHERE gained
  `(sales_end_at IS NULL OR sales_end_at > $now)`, the command's instant, in `takeSeats` and in
  the late payment's `takeAndSellSeats`. Chosen over accepting the sweeper's second: a second at an
  opening's rate is seats sold past the cutoff, and one predicate on a row already found by its key
  costs nothing. The purchase reads the same end off the unlocked aggregate first
  (`sellsSeatsAt`) and refuses before claiming its key. Past the end, `purchaseSeat` answers
  `order.sold_out`, the closed-sale answer it already gives, since the contract has no dedicated
  code; `quoteSeat` answers 404.
- **The sweeper closes it** (`CloseEndedSales`, a third `SweeperLoop`, every second): each sale on
  sale past its end, in a transaction of its own under the date's row (taken once, when nothing
  sells any more), `DateSales.endSales` closes it at its end as a closing outcome does: `on_sale`
  false, one move and `closing_due` for the publisher's last publication (0 seats, not sold out).
  `DateSalesEnded` reaches no wire of its own.
- **The late entry.** From the start, `quoteSeat` carries `lateEntry` (`startedAt`,
  `minutesElapsed` in whole minutes, `salesEndAt`), and its `validUntil` is no later than the start
  before it and the end after it, where what it says changes. `purchaseSeat` takes
  `acknowledgeLateEntry`: from the start and without `true`, it is refused 409
  `order.late_entry_unacknowledged` (an interim code, §3) with the same three facts in `params`,
  before its key is claimed or any seat taken; before the start the flag is ignored. Both fields are
  ahead of the contract: the report to "main" gives storefront.yaml's and the contracts' text.
- A replay under a key answers what it answered, whatever the clock says since: the fingerprint
  covers the flag.

## 1. What proves it

| Suite | What |
| --- | --- |
| `date-sales.aggregate.spec.ts` | 19 cases, plain Vitest, core never mocked |
| `date-sales.itest.ts` | the commands through the buses: replay, key reuse, stale version, two commands from one version, the lock, the counters as deltas under a hold, two currencies and an unprovisioned capacity past the threshold refused, a provision recorded and its two refusals, a tier past the threshold it covers, its deadline restated when the date moves, domain events after commit only, the outbox's rows in order |
| `catalog-date-consumer.itest.ts` | real Kafka: duplicate, superseded start and outcome, ignored, a fact before its draft retried then applied, poison dead-lettered |
| `publish-due-availability.itest.ts` | the rate bound (a seat every 500 ms for 12 s: four publications), selling out and back at once, a closing, a draft unpublished, a date a command holds published without waiting, `SKIP LOCKED` and four racing passes, a move during a publication neither waiting nor lost, the hold's wait behind a hundred-date pass, a date that cannot be published set aside and tried again |
| `migrations/availability-publication.itest.ts` | the publication table's migration on a database that already holds dates |
| `date-sales.http.itest.ts` | the routes over HTTP through the modules the API boots |
| `catalog-exchange.itest.ts` | catalog and ticketing read each other's real outbox rows, shaped as the connector routes them: a draft opens the sale, ticketing's capacity and price complete catalog's checklist, catalog publishes, the prices lock |
| `boot.itest.ts` | the three root modules |
| `orders/seat-order.aggregate.spec.ts`, `orders/seat-hold.aggregate.spec.ts` | the order's forward-only states, its seats created at payment, a payment after a failure (D-082), a refund owed; the hold's expiry its intent's, consumed or released once |
| `date-sales.aggregate.spec.ts` (T3's block) | on sale, the quote through core, a hold that moves the counter and not the version |
| `orders/purchase.itest.ts` | 19 cases through the buses: paid at once (counters, the hold consumed, `order.paid` then `seat.activated`, the cancel deadline, domain events after commit), a replay byte for byte with no second provider call, a key reused, two attempts at once, a crash between tx A and tx B resumed, a stale price and sold out writing nothing, a 202 replayed and read back by `getOrder`, a decline, the provider down then resumed, the quote; D-089: a purchase before the start without the flag, one after it refused unacknowledged with the facts and nothing held then sold acknowledged, one past the cutoff refused holding nothing, the hold's statement refusing past the cutoff on its own, the quote's `lateEntry` only after the start |
| `orders/expire-due-holds.itest.ts` | a due hold expired, its seats back, its order failed owing its intent's cancellation, a younger one left; the batch and the pass after it; a hold whose order another transaction holds skipped at once and taken the pass after; a pending order whose hold went back failed at its expiry |
| `boot.itest.ts` (T3's case) | the sweeper root expiring a due hold on its first pass |
| `orders/orders.http.itest.ts` | the three routes over HTTP, parsed by the contract's `SeatQuoteSchema`, `OrderSchema`, `PaymentHandoffSchema` and `TicketCardSchema` without `date`; 201 and 202 from one route; the replay's header and bytes; a late entry quoted, refused, then sold, `lateEntry` parsed by the contract's schema extended as the report gives it |
| `date-sales/seat-sales-window.spec.ts`, `date-sales.aggregate.spec.ts` (T3's second block) | D-089's end thirty minutes after the start, moved by a postponement; no late entry before the start, whole minutes after it; on sale until the end, not at it |
| `date-sales/close-ended-sales.itest.ts` | a sale past its end closed once, published a last time at 0 seats and not sold out, refusing a purchase; one running and one with no end left on sale; a sale closed thirty minutes after its start, and a postponed one whose end moved with its start left on sale |
| `migrations/seat-sales-cutoff.itest.ts` | the backfill on a database already holding dates: an end thirty minutes after each start, none without one |
| `orders/capacity.itest.ts` | adr-ticketing.md §3's concurrency test: 300 purchases at once on one date of 100 seats, ten at a time on its row through the pool: exactly 100 held (100 answered 202, 200 sold out), `seats_available` 0 and never below, and all 100 back at expiry; with quantities of one to three, paid or held, every seat accounted for (available + sold + held = capacity, one `seat` row per seat sold). Measured, three runs: the 300 purchases took 574, 634 and 946 ms, fake provider included |
| `payments/payment-webhooks.itest.ts` | over HTTP with the raw body: a confirmation recorded then applied, its seats and `order.paid` with the webhook's `traceparent`; a duplicate recorded and applied once, facts behind the order moving nothing; a forged signature and unsigned bytes refused, nothing recorded; a failure giving the seats back; an event with no order given up on, its bytes kept; D-082 both ways (seats taken again; none left, refunded at once under `refund:{orderId}` with `order.refunded`); a refund owed through a provider outage, made once on a later pass; a purchase resumed past its hold answering sold out; an expired order's intent cancelled, and asked again after an outage |
| `orders/payment-races.itest.ts` | the correctness review's cases, as written: a payment inserting its seats (slowed 1 s) leaves the date's row free, a hold's decrement bounded at 200 ms passing; expiry passes racing late payments on one date, every seat accounted for |
| `payments/payment-worker.itest.ts` | the correctness review's cases, as written: a webhook retried after a transient failure then applied once, backed off by `RETRY_DELAYS_MS` and given up on after the last; an event about no order kept and ignored; owed refunds not queued behind one refused for good, and a worker that pauses while a full batch is refused |
| `payments/fake-payment-provider.spec.ts` | the fake: a retried intent found under its order id, each scenario, one refund per key, cancelling, a signature over the exact bytes and its tolerance |

**`catalog-exchange.itest.ts` imports fourteen of catalog's internal modules by relative path**, no
manifest recording it (architecture review M5), and that is accepted, in a test only. Its point is
that each service's own consumer code reads the other's real outbox rows; a shared fixture or a
contract test on the proto alone would prove only that both sides read the same schema, not that
catalog's checklist rules accept what ticketing's aggregate writes. The cost is known: a rename
inside catalog breaks this suite, which is where it should be noticed. No production code of
either service imports the other.

## 2. What T4 inherits

What T3 inherited from T2 is built: the hot decrement (`takeSeats`) and `seats_sold`'s statement
(§0h), the unlocked load (`findUnlocked`), the stored snapshot moved with the decrement, the key on
`seat_order` alone (libs review L1), the hold expiry beside the publisher (§0i), and the closing
of sales by time, thirty minutes after the start (D-089, §0l). Topics `arthome.ticketing.order` (6,
`order_id`) and `.account` (3) are provisioned, and `order.paid` and `order.refunded` now reach the
first.

- **Refunds on a cancelled date** (adr-ticketing.md §8). A cancellation already closes the sale
  (T2), so no new hold is taken; but a hold active at that instant is still consumed by its payment,
  which never reads `on_sale`, so an order can be paid after its date was cancelled. T4's
  enumeration of the paid orders has to catch those too, or settle them as refunds.
- **The provider calls are marks on the order before they are calls**: `refund_owed_at` (with
  `refund_reason` and `refund_traceparent`) and `intent_cancel_owed_at`, each with its attempts,
  next attempt and dead mark, asked by the API process's payment worker under `refund:{orderId}` and
  `cancel:{orderId}` (§0j, §0k). T4's BullMQ queues (rate limit, bounded retries, a DLQ row and an
  alert, §8) can take them over from those columns, job ids being those keys; which process runs
  them is T4's to decide and record here, the sweeper staying on Postgres alone.
- **`cancelSeat` and `refundSeat`**: seats exist from payment with their code and a cancel deadline
  (an interim, §3); `seat.cancelled`, `SeatState` beyond `active`, and the order's
  `partially_refunded` are T4's. `refundReasonCode` is served once an order is `refunded`.
- **The race suite of adr-ticketing.md §12**: a duplicated and an out-of-order webhook, a success
  after the hold expired, declines and an abandoned action are proven (`payment-webhooks.itest.ts`,
  `purchase.itest.ts`); a refund racing a payment and a chargeback (`disputed`) are T4's.
- **A Stripe adapter** implements the two ports: an intent already succeeded is a cancellation that
  succeeded (`cancelIntent` is best effort), the intent is re-read from Stripe when a webhook leaves
  doubt (adr-payments.md §7.3, not built here), and the webhook route, refused in production like
  every write, is exempted once its signature is Stripe's.
- For T6: the TV pairing's hold (`SeatHoldOrigin.PAIRING`) has no order; the expiry pass joins each
  hold to its order, so a pairing hold needs its own branch there. The expiry's cost under load is
  the load test's.

## 3. Gaps

**Interims T3 holds until core carries them** (each named in the report to "main", with the exact
addition):

- `PaymentPort` and `PaymentWebhookPort` (`payments/payment.port.ts`), `adr-payments.md` §4's ports.
  Their methods take adr-ticketing.md §2's names (`createIntent`, `cancelIntent`, `refund`), as the
  lead decided on 2026-09-29, where adr-payments.md §4 names `authorize`, `capture`, `refund` and
  `quote`: core must settle one set when it carries the ports.
- `ORDER_STATES`, `SEAT_STATES`, `SEAT_HOLD_STATES`, `SEAT_HOLD_ORIGINS` and the order's forward
  ranks (`orders/commerce-vocabulary.ts`): the contract declares the first two as its own, and the
  domain decides with them.
- The seat's cancel deadline, one hour before the start (`orders/seat-cancel-deadline.ts`):
  needs/storefront-web.md's rule, served by the contract as `cancelDeadlineMinutesBefore: 60`, in
  no core constant. A date with no start gives its seats none.
- The order's reference, `ATH-{year}-{five digits}` off one sequence (`orders/order-reference.ts`),
  the contract's example.
- The payment return URL, `{PUBLIC_WEB_ORIGIN}/orders/{orderId}` (`orders/payment-return-url.ts`):
  no document names the storefront's page for it.
- No service fee (`date-sales/seat-quote.ts`): no fee schedule is set anywhere, as T2's pane says.
- D-089's rules (`date-sales/seat-sales-window.ts`): `SEAT_SALES_CUTOFF_MINUTES_AFTER_START` (30),
  `seatSalesEndAt`, `lateEntryOf` and `LateEntry`, under the names core will give them; the
  refusal's code `order.late_entry_unacknowledged` (`INTERIM_LATE_ENTRY_UNACKNOWLEDGED`,
  `orders/purchase-refusals.ts`), in no `ORDER_ERROR_CODES` yet; and the contract's fields ahead of
  storefront.yaml: `SeatQuote.lateEntry` and the purchase body's `acknowledgeLateEntry`.

**Known and left in T3, each judged:**

- **No account.** Tokens are not verified (`adr-auth.md` defers it): holds, orders and seats carry a
  null `account_id`, every purchase shares the one null idempotency scope, `order.paid` and
  `seat.activated` carry an empty `account_id`, and `getOrder` checks nobody's ownership. The routes
  are refused in production by `DenyInProductionGuard`, as every write here is. Accepted by the lead
  as an interim on 2026-09-29. **Until auth lands, `seat.activated` gives streaming's
  `entitlement_projection` no account to key the right to watch on**: a seat sold here opens nothing
  there.
- **No tax computed.** `order.paid` carries an empty `vat` and the buyer's declared location alone,
  as unresolved evidence: the tax model awaits counsel (`adr-payments.md` §5.5).
- **A free seat** (a total of zero) would ask the provider for an intent of zero: no rule gives a
  contribution or a free tier yet, so none is refused or special-cased.
- **A purchase resumed after the start is not asked to acknowledge it**: an order placed before the
  start whose provider did not answer, retried under its key after the start, holds its seats again
  without the flag its first body never needed. Asking then would strand it, since another body
  under the key is refused as reused.
- **A date postponed after its cutoff passed stays closed**: the sweeper closed it at its end, and a
  later start does not reopen it. D-076 allows a postponement until the date ends, so a
  postponement declared more than thirty minutes into the live meets this; none reopens a sale.

The three interims of the first handover are core's rules now (arthome-core PR #2, fbab36e):
`AVAILABILITY_VALID_SECONDS` and `availabilityValidUntil`, `provisionRevisableUntil` and
`assertTechnicalProvisionCovers`, `assertPricesShareCurrency`.

The technical provision is recorded by `setTechnicalProvision` (D-088, arthome-core PR #3,
7b271c7). The penalty exposure for a forecast far above the real figure has no rule in core yet
(D-088), so the pane serves none.

Known and left, each judged:

- `market_id` and the service-fee schedule have no source yet; neither is stored.
- **Catalog's service glue is shared since M4** (architecture review): `frozen` is
  `@arthome-platform/transactions`', `notFound`, `asConflict` and `edgeProviders` are
  `@arthome-platform/http-edge`'s, `httpApp` is `@arthome-platform/testing`'s, and
  `writeTicketingEvent` (`outboxWriter` over ticketing's topics) and the consumer host
  (`ConsumerHostModule`, its `/nest` entry) are `@arthome-platform/messaging`'s. `assert-never.ts` is still one copy
  per service: its home is core, which this repository does not edit.
- **`CLOCK` is provided in each feature module and in `EDGE_PROVIDERS`** (N2): catalog's pattern,
  harmless while `SystemClock` is stateless. `edgeProviders` takes the service's token rather than
  owning one; one provider per process root needs `CLOCK` exported from a module every feature
  imports, a change to the DI graph the lift left out.
- **`pricesLockedAt` is catalog's engagement instant**, not ticketing's consumption (correctness
  nit 2): the studio shows one lock instant, and the contract's examples give catalog's publication
  `pricesLockedAt` and ticketing's `lockedAt` the same value. A price change applied between the two
  instants is what the lock then holds.
- **Two services' clocks order one date's facts** (correctness nit 3): the API's for
  `pricing_changed` and `capacity_set`, the sweeper's for `availability_changed`, compared by
  latest-wins consumers. It takes a skew larger than the seconds between two facts, NTP makes that
  unlikely, and catalog does the same: a platform pattern, not T2's alone.
- Proven on the development stack on 2026-09-27 at 630dbd5, at e0967b4, and at 70307cb after the
  re-review's three fixes and their migration `1790440400000`: the interval, the 10 s retry of an
  unpublishable date, and a closing published through `closing_due` (AGENTS.md).
- T3 proven on the development stack on 2026-09-29 at 040190f (AGENTS.md, "The ticketing purchase
  path"): a purchase paid at once and replayed byte for byte, sold out past the seats, `order.paid`
  routed to `arthome.ticketing.order` on the order's key, the seats' events and the next
  availability on the date's, and a forged, a genuine and a duplicate webhook. A 202, the expiry and
  a late payment were not played there: the running fake confirms every intent, and the suites play
  them (§1).
