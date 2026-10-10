# `ticketing` — handover: a date's commercial face (T2), its holds, orders and payment (T3)

arthome-core `adr-ticketing.md` (accepted, D-077 to D-083) cuts the first slice into phases. T2 built
the service itself and `DateSales` (`data-model.md` §3.1), §0 to §0f; T3 the holds, the orders and
their payment, §0g onwards. Outcomes and refunds are T4, the waiting list T5, the waiting room T6,
the BFF routes T7; T4 opened with the worker process and its queues (§0m). Everything below was
run, against real Postgres, Kafka and Redis through `libs/testing`, not reasoned about.

## 0. Four processes, one database

| Process | Entry | Serves |
| --- | --- | --- |
| API | `node dist/main.js`, `PORT` (3004 in `.env.example`) | the studio's `setDatePrices`, `openCapacityTier`, `setTechnicalProvision`, `getDateTicketsPane`; the storefront's `refreshDateAvailability`, `quoteSeat`, `purchaseSeat`, `getOrder` (§0h); a seat's `cancelSeat` and `refundSeat` (§0o); the provider's webhooks and the payment worker that applies them (§0j); `/health/liveness`, `/health/readiness` |
| consumer | `node dist/consumer.js` | `arthome.catalog.date`, retrying on `arthome.ticketing.retry`, dead-lettering to `arthome.ticketing.dlq` |
| sweeper | `node dist/sweeper.js` | the availability publisher (§0e), the hold expiry (§0i) and the closing of sales whose time is over (§0l), Postgres alone |
| worker | `node dist/worker.js`, `REDIS_URL` | every call owed to the payment provider, a refund (§0k) or an intent's cancellation (§0i), made from BullMQ's queues, and the relay that feeds them (§0m); Postgres and Redis |

**Stop all four before `migration:run`.** A migration may drop a column the running build still
reads (`1790440100000` moved three `date_sales` columns to the publisher's table; `1790441200000`
moved the refunds to `order_refund`): a rolling restart would fail their reads, and the consumer
could dead-letter facts it can no longer apply.

All four read `DATABASE_URL` through `libs/config` (`NODE_ENV` required, never defaulted), close
their pool on SIGTERM, and are booted as their entry points boot them by `src/boot.itest.ts`. The
worker alone reads `REDIS_URL` (`readRedisUrl`, required in production): the API, the consumer and
the sweeper hold no Redis, so a Redis outage stops no purchase, no webhook and no expiry. The API
binds the internal token's guard, `DenyInProductionGuard` behind it, the envelopes and the validation
pipe through `@arthome-platform/http-edge`'s `edgeProviders` (`src/edge-providers.ts`), as catalog
does. Its readiness fails only on the database; the slot, the publication and the outbox
retention answer `degraded`.

**From T3 the API needs two more variables in production**, where neither has a default and the
API refuses to boot without them: `PAYMENT_WEBHOOK_SECRET` (32 characters at least, §0g) and
`PUBLIC_WEB_ORIGIN` (the payment return URL, §0h). Every route using them is refused in production
today, but the boot reads them. And neither the API nor the worker boots in production while the
fake payment adapter is the only one (§2, the architecture review's P1): both import the payment
ports.

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

## 0f. Conventions

Catalog's, `apps/catalog/HANDOVER.md` §0f, through the same libraries: `TicketingTransactions` is
`TransactionRunner` over `ticketingTransactionOf`, the repository tracks with `AggregateTracker` and
saves with `saveVersioned`, commands answer through `runIdempotentlyVersioned`, consumers claim with
`claimMessage`. Domain events reach the `EventBus` after the commit and nothing subscribes to them.
Refusals: the aggregate throws core's `DomainError`, which the filter answers at the status core's
error registry gives its code; the consumer maps it (retry for an unknown date, dead-letter
otherwise).

T3's `SeatHold` and `SeatOrder` follow them, `TicketingTransaction` carrying `holds` and `orders`
beside `dateSales`. The departures, each the ADR's or stated where it is built:

- **Several aggregates in one transaction**: tx A writes the order, the hold and the date's counter;
  tx B and the webhook worker the order with its seats, the hold and the counters; the expiry pass
  holds, orders and dates. adr-ticketing.md §2 and §6 and data-model.md §3.1 prescribe it: the
  recorded decision `nestjs-ddd` rule 7 asks for.
- **The counters move by conditional statements, not by a save** (adr-ticketing.md §11 names the
  hold's alone): `takeSeats`, whose parameters the aggregate's `holdSeats` decides and refuses, and
  `sellHeldSeats`, `returnHeldSeats` and `takeAndSellSeats`, which take a bare id since no rule
  decides a payment's or an expiry's count. Report §8 proposes §11's wording for all four.
- **The purchase runs in two transactions** with the provider between them, keyed on its order
  rather than `runIdempotently` (§0h).
- **The expiry pass is set-based SQL** over its batch rather than one aggregate per row (§0i).

The storefront's handlers throw `RefusalException`, reached from HTTP alone; the payment worker's,
reached from no request, log a failure and leave it due.

## 0g. The payment ports (T3)

`@arthome/core` carries `adr-payments.md` §4's ports: `PaymentPort` (`createIntent`, keyed by the
order id, `cancelIntent`, keyed `cancel:{orderId}`, `refund`, keyed by its refund's row, §0m) and `PaymentWebhookPort`
(`verifySignature` on the exact bytes, `parse`). They are interfaces, so
`payments/payment-tokens.ts` holds the two injection tokens, `PAYMENT_PORT` and
`PAYMENT_WEBHOOK_PORT`, as `CLOCK` does. A provider's references are opaque strings, a next action's
`kind` too: `payments/next-action.ts` names the two kinds the fake and the suites speak.
`PaymentProviderUnavailable` says the provider could not say what it did, so the caller retries
under the same key.

`FakePaymentProvider` is the adapter bound by default (`payments.module.ts`), both ports on one
instance, since a webhook speaks of the intents it created. Deterministic: an intent's reference is
derived from its order id, event ids are counted, and each intent plays `scenarioOf(request)`:
`confirm` (the default, confirmed synchronously), `require_action` (then `completeAction` or
`failAction` hands back the signed webhook saying how it ended), `decline`, `unavailable`. `down`
makes every call fail, the provider-down drill. Each process binds an instance of its own:
the worker's, asked to refund or cancel an intent the API's created, knows it by its reference,
its order's, as confirmed, which is what the running fake makes of every intent (PT0, since the
refunds left the API process); its test helpers stay strict. **For PT4's drills on a running
stack**: a cancellation there does nothing the API's fake sees (an intent known as confirmed is
not cancelled), and a refund there skips the "has taken no money" refusal. Prove those in a
suite, where one fake serves every port. Its signature is Stripe's scheme on its own header,
`x-fake-payment-signature: t=<seconds>,v1=<HMAC-SHA256 of "t.body">`, refused past core's
`PAYMENT_WEBHOOK_TOLERANCE_SECONDS`, adr-payments.md §7.1's five minutes. The secret is `PAYMENT_WEBHOOK_SECRET` (`@arthome-platform/config`'s
`readPaymentWebhookSecret`), defaulted outside production only, 32 characters at least.

## 0h. Holds, orders and the purchase (T3)

`src/orders/`: `SeatHold` and `SeatOrder` (`data-model.md` §3.2, §3.3), their tables in
`1790440500000-holds-and-orders.ts`, and the storefront's `quoteSeat`
(`POST /v1/dates/:dateId/seat-quote`), `purchaseSeat` (`POST /v1/orders/seats`) and `getOrder`
(`GET /v1/orders/:orderId`), in storefront.yaml's shapes but for `TicketCard.date` and the 201's
`date`: catalog's `DateCard`, which ticketing cannot build without calling catalog (critical rule 1),
so the BFF adds them (T7, agreed with the lead). The HTTP suite parses the tickets with the
contract's `TicketCardSchema` minus `date`. **The DateCard's seat figures must be ticketing's**
(architecture review m6): catalog's projection of them follows `availability_changed`, published at
most every five seconds, so a card composed from catalog alone repaints the seats as they were
before the purchase; the BFF overlays `refreshDateAvailability`'s figures, read after the purchase. The two reads require `x-arthome-deadline`, as `refreshDateAvailability`
does; the three answer `no-store`.

- **The purchase is adr-ticketing.md §2** (`purchase-seat.handler.ts`). Tx A binds the key to a new
  order, verifies the price, takes the seats with the one conditional decrement, inserts the hold
  (checkout, expiring with its intent: core's `checkoutIntentExpiry`) and the order, pending, its
  quote frozen. Outside any transaction, `PaymentPort.createIntent`, keyed by the order id. Tx B
  applies what the provider said, forward only; confirmed, `settleConfirmedPayment` consumes the
  hold, moves `seats_sold`, draws the seat codes and pays the order, which writes `order.paid` on the
  order's key, then one `seat.activated` per seat on the date's (D-077, D-078). It answers 201 with
  the tickets and the order, 202 with the `PaymentHandoff` (its `expiresAt` the hold's), 402
  `order.payment_declined` with the provider's `declineCode` when it gave one (hold released, seats
  back), or 503
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
- **3-D Secure whichever lands first** (review M4). A `requires_action` webhook carries no client
  secret; applied before tx B, it records the intent without one. `recordIntent` completes a known
  intent with the secret and next action the provider tells of the same one, whatever the order of
  arrival, so tx B still answers the handoff. And a purchase resumed while its order waits for the
  buyer on a secret-less intent (the webhook applied after a crash between tx A and tx B) asks the
  provider again, who hands the same intent back with its secret: never `order.sold_out` while the
  buyer's seats are held.
- **The provider down** (adr-ticketing.md §12's drill) releases the hold, gives the seats back and
  answers 503, and the order stays pending, bound to its key: a retry under the same key resumes it,
  holds the seats again (a new hold, the first `released`) or fails it sold out, and asks the
  provider under the same order id, so a charge the provider made before timing out cannot be made
  twice.
- **Lock order:** an order before its hold, everywhere; the date's row last. **The counter
  statement is the last of its transaction** (review M2), so the hot row is locked for the commit
  alone, as adr-ticketing.md §2 budgets: tx A inserts the hold and writes its events before its
  decrement; tx B and the webhook worker are handed the payment's or the failure's counter move
  (`PendingCounterMove`) and run it after the seats, the outbox rows and the kept answer. A purchase
  resumed after a provider outage, the burst of every buyer retrying at once, renews its hold as
  tx A does: the new hold and the order's renewal first, `takeSeats` last (correctness re-review
  N1); with no seat left the whole transaction rolls back and the order is failed sold out in one
  after it, unless another attempt under its key renewed it meanwhile (then
  `api.idempotency_in_flight`). One statement still runs early, because its result decides what
  follows: D-082's `takeAndSellSeats` (pay or owe a refund), off the normal path.
- **The price** is core's `quoteSeats` over the date's own tier price (`date-sales/seat-quote.ts`),
  the rule `quoteSeat` serves and `purchaseSeat` verifies `expectedTotal` against: 409
  `order.price_stale` with `expectedAmountMinor`, `currentAmountMinor` and `currencyCode`, or 409
  `order.tier_unavailable` for a tier the date does not sell. With no promotion stored, no subscription known and no fee schedule set, a
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
  orders by `seat_order.hold_id`'s index (`1790441100000`, review m3: without it every order ever
  placed was read each second), `FOR UPDATE OF hold, placed SKIP LOCKED`. A hold whose order a
  payment holds is skipped, left to that payment, which consumes it or takes the seats again
  (D-082). The pass does keep the hold's lock it took before finding the order locked, so that
  payment waits for the pass's commit; no deadlock follows, since the pass waits on nothing but
  dates' rows, which a payment takes after its hold. Each hold is `expired`, its order `failed` if it still waited
  for its payment, and the seats go back by `returnHeldSeats`, one statement per date in `date_id`
  order, the dates' rows last, each counting a move for the publisher.
- **A pass also fails an order still pending past its expiry with no intent and no active hold**:
  the provider did not answer, the hold went back (§0h), and nobody retried the purchase. Its own
  partial index, `1790440600000-pending-order-expiry.ts`.
- **Cancelling the intent at the provider is recorded, not called** (decided in T3): an order that
  fails holding an intent gets `intent_cancel_owed_at`, and the sweeper calls no provider, so a
  provider outage cannot slow the pass that returns capacity, and the process keeps its one
  dependency. The worker's queue makes the call (§0m). The cancellation is best effort either way
  (§6): a confirmation already in flight arrives as a late payment, §0k.
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

## 0k. A payment confirmed after its hold expired (T3, D-082)

`orders/settle-payment.ts`, shared by tx B and the webhook worker. A confirmation for an order that
can still take a payment consumes its hold while that hold is active, even past its instant if the
sweeper has not reached it. When the hold is gone (expired, released), the seats are taken again
by `takeAndSellSeats`: `seats_available - q` and `seats_sold + q` in one statement, conditioned on
`on_sale AND seats_available >= q`. The order is then paid as any other, its failure cleared and
its owed cancellation dropped.

With none left, the order owes the money back (`SeatOrder.oweUnseatedPaymentBack`,
`hold_expired_capacity_lost`): one `order_refund` row of the whole total under its own key,
`refundIdempotencyKey(refundId)`,
written in the same transaction with the trace it was found under (`recordRefundTraceparent`), no
seat created, nothing sold, nothing asked of the provider. The worker's relay enqueues it within its
next second, the refund queue asks the provider under that key outside any transaction, then marks
the order `refunded` with `order.refunded` (`refund_reason` `HOLD_EXPIRED_CAPACITY_LOST`, no seat
cancelled) under that trace (§0m). The first try at once that T3 made from the purchase and the
webhook worker is dropped by choice (PT0 O3): one path for every call, under the limiter, within the
relay's second. Never an oversold date, never money kept without a seat. `payouts` receives this
`order.refunded` for an order it never saw `order.paid`.

**Replaying a call given up on.** After its schedule's failed attempts, or its job stalled past its
bound or lost (§0m), the refund is marked `dead_at` and
an error is logged: "the buyer's money is held without a seat until an operator replays the refund".
`pnpm run ops:check ticketing` reports it, `provider_calls_dead` degraded with the replay statement
in its detail. Find them with `SELECT id, order_id, idempotency_key, owed_at, dead_at FROM
order_refund WHERE dead_at IS NOT NULL AND refunded_at IS NULL`. Once the cause is gone (the
provider's incident over, or the refusal understood and settled at the provider), and **once the
refund is looked up at the provider by its refund id**, which past the key's 24 hours alone tells
whether it was made (§2), replay one with:

```sql
UPDATE order_refund SET dead_at = NULL, enqueued_at = NULL
 WHERE id = '<refund id>' AND dead_at IS NOT NULL;
```

The relay enqueues it again within a second, its schedule anew, under the same key, so a refund the
provider made meanwhile is not made twice, and the order is then `refunded` with its
`order.refunded`. Do not replay while the provider still refuses it for a reason of its own (a
disputed charge): the call would be given up on again a day later. An intent's cancellation is
replayed the same way, `UPDATE seat_order SET intent_cancel_dead_at = NULL,
intent_cancel_enqueued_at = NULL WHERE id = '<order id>' AND intent_cancel_dead_at IS NOT NULL`,
which is only worth it while the intent could still be confirmed.

A purchase replayed under its key once its hold expired, never having reached the provider,
answers `order.sold_out` from the failed order and asks the provider nothing.

## 0l. Seat sales end thirty minutes after the start, and a late buyer is told (T3, D-089)

A sale ends by time, so no date is sold after its show and none stays in the publisher's pass for
good (§0e). The product owner ruled (D-089, recorded in core by the lead): **a seat covers the live alone** (a replay's access is a separate matter, out of T3), **its
sales end `SEAT_SALES_CUTOFF_MINUTES_AFTER_START` (30) minutes after the live's start**, the same
for every channel, and **a buyer arriving after the start is told what was missed and must
acknowledge it**. The rules are core's `seatSalesEndAt(startsAt)`, `salesEndedBy` and
`lateEntryOf(startsAt, now)`.

- **The end** is `date_sales.sales_end_at` (`1790440800000-sales-end.ts`), written by
  `recordSchedule` from `seatSalesEndAt` whenever catalog states or moves the start, so a
  postponement moves it; `1790440900000-seat-sales-cutoff.ts` backfilled it for the dates already
  scheduled.
- **A postponement applied late reopens a sale closed by time** (review m1). Core refuses a
  postponement once the live has started (`assertOutcomeDeclarable`, catalog's `outcome.ts`), so one
  declared in time always precedes the old cutoff; but the consumer may apply it after, when Kafka,
  the connector or the retry topic lags, and the sweeper, Postgres alone, closes the sale meanwhile.
  `recordSchedule` then reopens it (`DateSalesReopened`, one move for the publisher) when no closing
  outcome was recorded and the new end is ahead: sales go on, as adr-ticketing.md §8 has them.
- **The hold's statement refuses past the end by itself**: its WHERE gained
  `(sales_end_at IS NULL OR sales_end_at > $now)`, the command's instant, in `takeSeats` and in
  the late payment's `takeAndSellSeats`. Chosen over accepting the sweeper's second: a second at an
  opening's rate is seats sold past the cutoff, and one predicate on a row already found by its key
  costs nothing. The purchase reads the same end off the unlocked aggregate first
  (`sellsSeatsAt`) and refuses before claiming its key. **Past the end both `purchaseSeat` and
  `quoteSeat` answer 409 `order.sales_closed`** (core's `OrderErrorCode.SALES_CLOSED`; architecture review M2), with
  `salesEndAt`: sold out is the waiting list's cue, and a sale that ended offers no waiting list.
  Whether it ended is one rule, `salesEndedBy`, which the aggregate, the quote and the statement's
  predicate share.
- **The sweeper closes it** (`CloseEndedSales`, a third `SweeperLoop`, every second): each sale on
  sale past its end, in a transaction of its own under the date's row (taken once, when nothing
  sells any more), `DateSales.endSales` closes it at its end as a closing outcome does: `on_sale`
  false, one move and `closing_due` for the publisher's last publication (0 seats, not sold out).
  `DateSalesEnded` reaches no wire of its own.
- **The late entry.** From the start, `quoteSeat` carries `lateEntry` (`startedAt`,
  `minutesElapsed` in whole minutes, `salesEndAt`), and its `validUntil` is no later than the start
  before it and the end after it, where what it says changes. `purchaseSeat` reads the header
  `X-Arthome-Late-Entry-Acknowledged: true` (anything else but its absence is 400 naming it): from
  the start and without it, the purchase is refused 409 `order.late_entry_unacknowledged`
  (core's `OrderErrorCode.LATE_ENTRY_UNACKNOWLEDGED`) with the same three facts in `params`, before its key is claimed or any seat
  taken; before the start it is ignored. The field and the header are the contract's.
- **A header, not the body** (architecture review m2, the lead's decision), as the admission token
  is: the idempotency fingerprint covers the body, so a flag there could never be added to a
  purchase placed before the start and retried after it. **Decided here: such a retry is asked
  too.** A purchase resumed under its key that goes on to the provider after the start (its first
  attempt interrupted, or the provider down) is refused unacknowledged like a new one, its order
  untouched, and resumes once the retry carries the header. A replay of an answer already kept
  answers it again, whatever the clock says since. Past the cutoff, a resumed purchase whose hold is
  gone is answered 409 `order.sales_closed` at once, before it is asked anything, as a new one is,
  and its order fails with that code, so every retry under the key answers the same; one whose hold
  is still active took its seats in time and goes on.

## 0m. The worker process: every provider call on BullMQ (T4, PT0)

`src/worker.ts` and `src/worker.module.ts`; in `payments/`, `provider-call-queues.ts` and its
module, `owed-call-relay.ts`, `refund.processor.ts`, `intent-cancellation.processor.ts`,
`refund-ledger.ts`. adr-ticketing.md §8: "Each queue is rate-limited below the provider's API limit
and uses provider idempotency keys ... Retries are bounded, with backoff and jitter, then a DLQ row
and an alert." The fact stays in Postgres, written in the business transaction; a relay moves it
to the queue.

- **A fourth process, not the API** (T4's to decide, decided here). It alone holds Redis and calls
  the provider: the API stays ready on the database alone (AGENTS.md), a drain of refunds shares
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
  long ago (about 23.1 h) and unsettled is given up instead, its row dead and §0k's error logged:
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

## 0o. A seat's cancellation and refund, and the provider's refund and dispute webhooks (T4, PT2)

`src/seats/` and the seat parts of `orders/`; `1790441350000-seat-states.ts` (processes stopped).

- **A seat leaves `active`** by core's `seatStateMayMove`: `cancelled` when its cancellation is
  decided, with `ended_at`, `cancel_reason`, its refund and its share (`refund_id`,
  `refund_amount_minor`); `refunded` once that refund is made (`SeatOrder.refundMade`, from the
  processor's answer or a refund webhook, whichever comes first); `credited` with its credit and
  share (`credit_id`, `credit_amount_minor`; PT1, whose `credit` table takes the foreign key). A
  seat no longer active is refused 409 `seat.not_active` with its `state`. CHECKs: `ended_at` null
  exactly while active, each amount with its id, a refund's share above zero and a credit's at
  zero or more (a credit split over more seats than its minor units still credits each seat).
- **The seam PT1 calls**: `SeatOrder.cancelSeats({ reason, refundId, seats: [{ seatId,
  refundAmount }] }, now)` and `creditSeats({ creditId, seats: [{ seatId, creditAmount }] }, now)`.
  The refund is one the order owes, a share of nothing is recorded as nothing given back (the seat
  stays `cancelled` for good), and either refuses before anything moves.
- **The wire**: one `ticketing.seat.cancelled.v1` per seat cancelled, on
  `arthome.ticketing.date_sales` keyed by the date (`seat_id`, `date_id`, the seat's `account_id`,
  `reason` through `WIRE_SEAT_CANCEL_REASON`, never `PAYMENT_FAILED`), in the transaction that saves
  the order, for streaming's entitlements and payouts. A credit reaches no wire (`SeatsCredited`,
  D-092). `order.refunded`'s `reason` is `seatCancelReasonOf` of its refund's, `UNSPECIFIED` for a
  refund that cancels no seat (D-082's, `goodwill`, `duplicate`, `dispute`).
- **The reads**: `TicketCard.refund` is null while active and for a seat cancelled with nothing given
  back; from the cancellation on, the seat's share, `original_payment_method`, `refundDelayCodeOf`'s
  delay and its refund's reason; a credited seat its credit's share, `account_credit`, no delay and
  no reason. `Order.refundReasonCode` on `refunded` and `partially_refunded`, the latest refund
  made's. `getOrder`, `purchaseSeat` and the two routes serve them through `ticketViewsOf`.
- **`cancelSeat`** (`POST /v1/seats/:seatId/cancel`, `SeatsController`, `no-store`): the token's
  account (401 without), `Idempotency-Key` scoped by it, the body optional and strict. A seat
  unknown, another account's or with none: 404. Then core's `assertSeatCancellable`:
  `seat.not_active`, then `seat.cancel_deadline_passed` with `cancelDeadline` (none: cancellable).
  The refund is the seat's entry of `seatSharesOf(total, quantity)`, seats in id order, capped at
  `refundableLeft`, owed under `refundIdempotencyKey` with the request's trace; on a `disputed`
  order, or once nothing is left, the seat is cancelled with nothing refunded (the provider holds
  the money, adr-payments.md §9; the lead's ruling). The seat returns to sale at once (D-093) by
  `releaseSoldSeats`: `seats_available + 1`, `seats_sold - 1`, one move, so a sold-out date is
  published back at once. **On a date a cancellation closed** the refund is `date_cancelled` (core's
  `refundReasonOnDate`, D-097), the deadline is not applied and no seat returns to sale. It answers
  `{ ticket }`, the `TicketCard` but its `date`, which the BFF adds (T7).
- **`refundSeat`** (`POST /v1/seats/:seatId/refund`, `SeatRefundsController`, `no-store`): the
  studio's, `Idempotency-Key` in the operator's scope, `If-Rights-Version` parsed (an integer, else
  400 naming it), its check and the 403 auth slice B's, refused in production with the other studio
  routes. 404; 409 `seat.not_active`; a `disputed` order 409 `state.conflict` with the order's
  version and its state; `date_cancelled` on a date no cancellation closed 409 `state.conflict`
  with the date's version and its outcome when it has one (D-097, the lead's ruling); past
  `refundableLeft`, or nothing left, 409 `refund.amount_exceeds_remaining` with `remainingMinor`.
  The amount is `partialAmountMinor` in the order's currency, else the seat's share capped as
  above. Only `date_cancelled` cancels the seat (`refundCancelsSeat`, D-095), with no counter move;
  `goodwill`, `duplicate` and `dispute` leave it active whatever the amount. It answers `{ refunded,
  payoutId: null }`, with no `commissionRefunded` until payouts compute it (the commission is taken
  on the net of tax, which awaits counsel).
- **Lock order** (§0h): the seat read without a lock to find its order, the order locked
  (`findById`), then its seats and refund rows, the date's outcome read unlocked (`findUnlocked`),
  the date's row last: `releaseSoldSeats` is handed back as a `PendingCounterMove` and runs after
  the outbox rows and the kept answer, just before the commit (measured in `cancel-seat.itest.ts`: a
  hold's statement passes under its 200 ms bound while the cancellation's outbox insert sleeps a
  second). The key is claimed in the transaction that writes the refund and the seat. Neither route
  calls the provider or Redis: the worker's queue makes the refund (§0m).
- **A refund webhook** (`refund_succeeded`, its `refund_ref` and the cumulative `amount_refunded`
  kept on the inbox row) marks no refund made (R15, replaced by the lead after the PT2 review): a
  cumulative says how much was refunded, not which refunds, and two equal shares cannot be told
  apart. For each refund still owed (neither made nor given up on) that the amount no refund made
  explains could cover, it stamps `order_refund.rerun_asked_at` in its transaction. The relay's
  next pass promotes that refund's job when it waits its backoff (job id `jobIdOf(refund:{id})`),
  keeps the request while the job runs, and clears it otherwise: a job queued runs soon, and one
  lost is left to the stale sweep, never added again, since a call past the key's retention may be
  made twice. The provider answers under the refund's key, the existing refund or a new one, and
  the processor marks it made with its own reference and its `order.refunded`. It covers a call
  that timed out after the provider made the refund. A cumulative past every refund the order
  holds (a refund made outside the platform) is kept as applied, ignored and logged. Later (a core
  seam): the platform's refund id in the refund's metadata, carried back on the webhook, marks that
  refund made by id.
- **A dispute** (`dispute_opened`): the order `disputed`, above `refunded`, its seats left active,
  no provider call and no event (C1 adds none); one reaching an order not yet paid settles the
  payment first, as a confirmation would, so the seats a disputed charge implies exist. A refund
  still owed on it stays owed: the fake, as Stripe, refuses a refund on a disputed charge as a
  refusal, not `PaymentProviderUnavailable`, so the queue retries it to its bound and its dead row,
  which the provider's dispute settles (§0k: do not replay it).
- **The fake** (§0g) plays both, signed as `completeAction`'s: `refundSucceededWebhookOf(refundRef)`,
  with what the charge refunded up to that refund, and `disputeOpened(intentRef)`.

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
| `boot.itest.ts` | the four root modules; the worker's (PT0) on Redis, a refund owed made by its first passes, its shutdown awaiting the provider call in flight before the pool closes |
| `orders/seat-order.aggregate.spec.ts`, `orders/seat-hold.aggregate.spec.ts` | the order's forward-only states, its seats created at payment, a payment after a failure (D-082), a refund owed under its own key and no payment taken after it, an intent reaching a failed order owing its cancellation from the instant first owed; the ledger (PT0): two refunds, `partially_refunded` then `refunded`, one past `refundableLeft` or of nothing refused, none owed on an order holding no money, one owed again answered and changing nothing, its id or key with other facts refused; the seats (PT2): one of three cancelled then refunded when its refund is made, the others active, one `SeatCancelled` per seat, nothing given back cancelled for good (a share of nothing, a disputed order), a seat not active refused `seat.not_active` moving nothing, credited seats, a dispute above `refunded`, shares past the refund named or a seat named twice refused moving nothing; a refund webhook marking nothing made, two equal refunds the newer made first, naming the owed refunds its unexplained amount could cover, and none past the ledger; the hold's expiry its intent's, consumed or released once |
| `date-sales.aggregate.spec.ts` (T3's block) | on sale, the quote through core, a hold that moves the counter and not the version |
| `orders/purchase.itest.ts` | 23 cases through the buses: paid at once (counters, the hold consumed, `order.paid` then `seat.activated`, the cancel deadline, domain events after commit), a replay byte for byte with no second provider call, a key reused, two attempts at once, a crash between tx A and tx B resumed, a stale price and sold out writing nothing, a 202 replayed and read back by `getOrder`, a decline, the provider down then resumed, its renewed hold's decrement last (another buyer's does not wait on it), and a renewal finding no seat rolled back and failed sold out for good, the quote; D-089: a purchase before the start without the header, one after it refused unacknowledged with the facts and nothing held then sold acknowledged, one past the cutoff refused `order.sales_closed` holding nothing, the hold's statement refusing past the cutoff on its own, the quote's `lateEntry` only after the start, a purchase resumed after the start asked then sold, and one resumed past the cutoff closed at once and for good |
| `orders/expire-due-holds.itest.ts` | a due hold expired, its seats back, its order failed owing its intent's cancellation, a younger one left; the batch and the pass after it; a hold whose order another transaction holds skipped at once and taken the pass after; a pending order whose hold went back failed at its expiry |
| `boot.itest.ts` (T3's case) | the sweeper root expiring a due hold on its first pass |
| `orders/orders.http.itest.ts` | the three routes over HTTP, parsed by the contract's `SeatQuoteSchema`, `OrderSchema`, `PaymentHandoffSchema` and `TicketCardSchema` without `date`; 201 and 202 from one route; the replay's header and bytes; a late entry quoted, refused, then sold, `lateEntry` parsed by the contract's schema extended as the report gives it |
| `date-sales.aggregate.spec.ts` (T3's second block) | D-089's end thirty minutes after the start, moved by a postponement; on sale until the end, not at it (core's `seats.spec.ts` proves `seatSalesEndAt` and `lateEntryOf`) |
| `date-sales/close-ended-sales.itest.ts` | a sale past its end closed once, published a last time at 0 seats and not sold out, refusing a purchase; one running and one with no end left on sale; a sale closed thirty minutes after its start, and a postponed one whose end moved with its start left on sale |
| `date-sales/postponement-reopen.itest.ts` | the correctness review's case, as written: a sale closed by time, a postponement stated before the old start and applied after it reopening the sale until thirty minutes after the new start |
| `migrations/seat-sales-cutoff.itest.ts` | the backfill on a database already holding dates: an end thirty minutes after each start, none without one |
| `orders/capacity.itest.ts` | adr-ticketing.md §3's concurrency test: 300 purchases at once on one date of 100 seats, ten at a time on its row through the pool: exactly 100 held (100 answered 202, 200 sold out), `seats_available` 0 and never below, and all 100 back at expiry; with quantities of one to three, paid or held, every seat accounted for (available + sold + held = capacity, one `seat` row per seat sold). Measured, three runs: the 300 purchases took 574, 634 and 946 ms, fake provider included |
| `payments/payment-webhooks.itest.ts` | over HTTP with the raw body: a confirmation recorded then applied, its seats and `order.paid` with the webhook's `traceparent`; a duplicate recorded and applied once, facts behind the order moving nothing; a forged signature and unsigned bytes refused, nothing recorded; a failure giving the seats back; an event with no order given up on, its bytes kept; D-082 both ways (seats taken again; none left, the refund owed in the webhook's transaction under its own key with its trace, nothing asked of the provider); a purchase resumed past its hold answering sold out; a cancellation given up on, owed again by a late webhook from its first instant for a new job, and owed anew once made |
| `orders/expiry-plan.itest.ts` | the correctness review's case, as written: over 20,000 orders, the expiry pass's plan reads no `seat_order` sequentially |
| `orders/payment-races.itest.ts` | the correctness review's cases, as written: a payment inserting its seats (slowed 1 s) leaves the date's row free, a hold's decrement bounded at 200 ms passing; expiry passes racing late payments on one date, every seat accounted for |
| `orders/three-d-secure.itest.ts` | the correctness review's cases, as written: a `requires_action` webhook applied before tx B, and one applied after a crash between tx A and tx B then the purchase replayed: 202 with the handoff and its client secret both times |
| `payments/payment-worker.itest.ts` | the correctness review's cases, as written: a webhook retried after a transient failure then applied once, backed off by `RETRY_DELAYS_MS` and given up on after the last; an event about no order kept and ignored (its owed-refund cases are the queues' now) |
| `payments/fake-payment-provider.spec.ts` | the fake: a retried intent found under its order id, each scenario, one refund per key, cancelling, an intent another instance created refunded by its reference, a signature over the exact bytes and its tolerance; a refund webhook carrying what its charge refunded up to it, a dispute confirming the charge, and a refund on a disputed charge refused, not unavailable (PT2) |
| `payments/owed-calls.spec.ts` | a refund's delays doubling from 5 s to their one-hour cap, adding up to a day; an intent's cancellation on the consumers' bound |
| `payments/provider-call-queues.spec.ts` | `jobIdOf` over each key, no colon and never an integer; one attempt more than the delays, the custom backoff, nothing kept; each backoff within its schedule's jitter and none after the last; the stale windows |
| `payments/provider-call-queues.itest.ts` | real Postgres and a Redis of its own: a call owed past a minute and never enqueued turning `provider_calls_waiting` degraded, then up once enqueued; a refund owed twice recorded once, and a key another refund holds refused with the transaction still alive; a D-082 refund owed by a webhook, made once, `order.refunded` under the webhook's trace; the provider down on a shortened schedule, given up with `dead_at` and §0k's error, `provider_calls_dead` degraded, then replayed and made once under the same key; 60 refunds at 20 a second in two seconds at least; Redis paused while a purchase, a webhook and an expiry commit, the relay failing within its timeout with nothing stamped and its locks released, then each call made once, `provider_call_queues` degraded then up; a worker killed mid-call, its stalled job run again, one refund at the fake; a cancellation cleared by a payment, no call; one owed again once given up on, a new job; a job stalled twice run again, one refund, and one stalled past its bound given up with its row dead and the error; jobs lost to `FLUSHDB`: the refund given up past its stale window with the error, never asked again, the cancellation enqueued again and made; two relays racing over 1,000 refunds, enqueued again after their commits were lost, each job completed once and each refund made once |
| `migrations/provider-call-queues.itest.ts` | the backfill over refunds owed, made and given up on and an owed cancellation: one row each under `refund:{orderId}`, the owed ones due to the relay after; a second D-082 refund of one order refused by `uq_order_refund_unseated`; `down` refused while an unsettled refund is keyed by its own id, then putting them back once it is settled |
| `payments/relay-plan.itest.ts` | over 20,000 refunds made and 20,000 orders, no claim reads its table sequentially, the refund webhook's reruns included |
| `seats/cancel-seat.itest.ts` | PT2, real Postgres and Redis: one seat of three cancelled, its share owed under `refundIdempotencyKey` with the request's trace, `seat.cancelled` `VIEWER_REQUEST` on the date's key, the seat back on sale and a sold-out date published back at once; the queue making it, `refunded`, `partially_refunded`, `order.refunded` `VIEWER_REQUEST`, then the two others and the order `refunded`; a replay byte for byte; a key reused; another account's seat and an unknown one 404; past the deadline 409 with the instant; a seat already refunded 409 with its state; a cancelled date `date_cancelled` past the deadline with no counter move; a disputed order cancelled with nothing refunded; a hold's statement passing under 200 ms while the cancellation's outbox insert sleeps a second |
| `seats/refund-seat.itest.ts` | PT2: `goodwill` in part, the seat active, the order `partially_refunded`, no `seat.cancelled`, `order.refunded` `UNSPECIFIED`; `duplicate` in full, then past what is left 409 naming it and nothing left 409; `date_cancelled` on a date scheduled, then interrupted, 409 `state.conflict` naming the outcome; on a cancelled date the seat cancelled, no counter move, then refunded; a seat no longer active and a disputed order 409; a replay |
| `seats/seats.http.itest.ts` | PT2: both routes over HTTP through the modules the API boots, `TicketCardSchema` without `date` and `refundSeat`'s contract envelope; a replay's header and bytes; 401 without an account; 400 for a malformed body, a missing key and a malformed `If-Rights-Version`; `getOrder` serving `TicketCard.refund` and `Order.refundReasonCode` once the refund is made |
| `payments/refund-dispute-webhooks.itest.ts` | PT2, over HTTP with the raw body, the queues on Redis: a refund made while its call timed out marked nothing made, its call re-run, the provider's answer under its key marking it made once with that reference, its seat refunded, duplicates and a second webhook applied once; two equal refunds waiting an hour's backoff, the newer made at the provider, its webhook marking neither, both jobs promoted, each made with its own reference, the older asked once; a refund made outside the platform kept and ignored; a dispute on a paid order `disputed`, seats active, no call, no event; a dispute before its confirmation settling the payment, its seats and events written, then `disputed`; a refund on a disputed charge refused by the fake, retried to its dead row |

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
- ~~The provider calls on BullMQ~~: built (PT0, §0m), in a fourth process, the worker; refunds are
  `order_refund` rows, several per order, and `partially_refunded` is the ledger's.
- ~~`cancelSeat` and `refundSeat`~~, ~~`seat.cancelled` and `SeatState` beyond `active`~~: built
  (PT2, §0o), owing their refunds through `SeatOrder.oweRefund` (§0m); `refundReasonCode` is served
  on `refunded` and `partially_refunded`.
- **The race suite of adr-ticketing.md §12**: a duplicated and an out-of-order webhook, a success
  after the hold expired, declines and an abandoned action are proven (`payment-webhooks.itest.ts`,
  `purchase.itest.ts`); a chargeback (`disputed`) is applied (§0o); a refund racing a payment, and
  the races over `cancelSeat`, are PT4's.
- **A Stripe adapter** implements the two ports:
  - an intent already succeeded is a cancellation that succeeded (`cancelIntent` is best effort),
    and a refund retried past Stripe's 24 h key retention, answered `charge_already_refunded`, is a
    refund made; that holds for D-082's refund of the whole payment alone;
  - **past the key's 24 hours, a refund is looked up before it is sent again** (the review's S4).
    Stripe forgets the key then, so a partial refund (PT1, PT2) asked again would be made a second
    time. The automatic attempts stay inside the window (`REFUND_RETRIES_WITHIN_MS`, 23 h; a lost
    job is given up, not enqueued again, §0m). What can still cross it is §0k's replay of a dead
    refund: until the adapter does it, the operator looks the refund up at the provider by our
    refund id, and the adapter, sending our refund id in the refund's metadata, looks it up there
    before creating one whenever the row was owed more than the window ago (D-098: not this
    slice);
  - a renewed hold moves the order's `expiresAt` before `createIntent` is asked again under the same
    order id, and Stripe refuses a key reused with other parameters: the adapter keeps the expiry
    out of the idempotent request, or sends the first one;
  - the intent is re-read from Stripe when a webhook leaves doubt (adr-payments.md §7.3, not built
    here);
  - ~~its request timeout below the claim's 5 s lease~~: gone with the claims (§0m), a job's lock
    being renewed while its worker lives; its timeout bounds a job, and the grace period covers it;
  - Stripe's 429 sets the queue's limit (`queue.rateLimit`, then `throw Worker.RateLimitError()`,
    no attempt consumed), and the limits of §0m are revisited against the live account's;
  - the webhook route, refused in production like every write, is exempted once its signature is
    Stripe's.
- **Lifting `DenyInProductionGuard` needs a real adapter bound first**: the fake confirms every
  intent without taking any money, so `payments.module.ts` refuses to bind it in production and the
  API and the worker fail at boot there (`payments.module.spec.ts`, the architecture review's P1).
  The consumer and the sweeper import no payment port and boot. The real adapter lifts both locks: the boot refusal,
  and `DenyInProductionGuard` on `OrdersController` and `PaymentWebhooksController`.
- **A postponement moves the seats' cancel deadline** (adr-ticketing.md §8): each seat carries the
  deadline computed at payment, and `seat.activated` published it; nothing recomputes it or tells
  streaming and notifications that it moved.
- **A late payment on a date since cancelled** is refused by `takeAndSellSeats` (`on_sale` false)
  and refunded as `hold_expired_capacity_lost`, not `date_cancelled`: T4's cancellation refunds
  decide whether that reason is the one the viewer should read.
- For T6: the TV pairing's hold (`SeatHoldOrigin.PAIRING`) has no order; the expiry pass joins each
  hold to its order, so a pairing hold needs its own branch there. The expiry's cost under load is
  the load test's.

## 3. Gaps

**T3's interims are core's now** (arthome-core PR #7, a54847c): the payment ports, the order, seat
and hold vocabularies, the order-state ranks, the seat's cancel deadline, the order reference, the
payment return path, D-089's `SEAT_SALES_CUTOFF_MINUTES_AFTER_START`, `seatSalesEndAt`,
`salesEndedBy`, `lateEntryOf` and `LateEntry`, the codes `order.late_entry_unacknowledged` and
`order.sales_closed`, `HOLD_EXPIRY_BATCH` and `PAYMENT_WEBHOOK_TOLERANCE_SECONDS`. Core's
`decideWatch` no longer offers `buy_seat` past the cutoff. What stays local, and why:

- The injection tokens `PAYMENT_PORT` and `PAYMENT_WEBHOOK_PORT` (`payments/payment-tokens.ts`):
  core's ports are interfaces, which Nest cannot inject.
- `NextActionKind` (`payments/next-action.ts`): core keeps a next action's `kind` opaque, and only
  the fake provider and the suites name two.
- `ORDER_STATES_AWAITING_PAYMENT` (`orders/awaiting-payment.ts`): which states a payment's failure
  or expiry moves is this service's decision, not a vocabulary.
- Two seams core leaves to the caller: the year of an order reference, read off the placement
  instant, the sequence being this database's (`seat-order.typeorm-repository.ts`), and the
  `PUBLIC_WEB_ORIGIN` before core's `paymentReturnPath`, the origin being deployment configuration.
- No service fee (`date-sales/seat-quote.ts`): no fee schedule is set anywhere, as T2's pane says.

**Known and left in T3, each judged:**

- **The account is the internal token's** (auth slice A, 2026-10-03), and the commerce routes stay
  refused in production until a real payment adapter: `quoteSeat`, `purchaseSeat` and `getOrder`
  need a token naming an account (401 otherwise, no guest purchase); a purchase binds
  its hold, order and seats to it, its idempotency key is scoped by it, and `order.paid` and
  `seat.activated` carry it. The profile is the token's too (`PurchaseSeat.buyer`): a body naming
  another one is a 403, and until profiles land no token names any. `getOrder` serves the buyer alone: someone else's order is a 404, as one
  that does not exist. An order placed before slice A has no account and is served to nobody. The
  studio's routes (prices, capacity, provision, the pane) stay refused in production until slice B
  authorises them on the loaded date.
- **No tax computed.** `order.paid` carries an empty `vat` and the buyer's declared location alone,
  as unresolved evidence: the tax model awaits counsel (`adr-payments.md` §5.5).
- **A free seat** (a total of zero) would ask the provider for an intent of zero: no rule gives a
  contribution or a free tier yet, so none is refused or special-cased.


The three interims of the first handover are core's rules now (arthome-core PR #2, fbab36e):
`AVAILABILITY_VALID_SECONDS` and `availabilityValidUntil`, `provisionRevisableUntil` and
`assertTechnicalProvisionCovers`, `assertPricesShareCurrency`.

The technical provision is recorded by `setTechnicalProvision` (D-088, arthome-core PR #3,
7b271c7). The penalty exposure for a forecast far above the real figure has no rule in core yet
(D-088), so the pane serves none.

Known and left, each judged:

- `market_id` and the service-fee schedule have no source yet; neither is stored.
- **Catalog's service glue is shared since M4** (architecture review): `frozen` is
  `@arthome-platform/transactions`', `notFound`, `refusalOf` and `edgeProviders` are
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
