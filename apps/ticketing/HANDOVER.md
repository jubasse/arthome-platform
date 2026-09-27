# `ticketing` — T2 handover: the service, and a date's commercial face

arthome-core `adr-ticketing.md` (accepted, D-077 to D-083) cuts the first slice into phases; this is
T2: the service itself and `DateSales` (`data-model.md` §3.1). Holds, orders and payment are T3,
outcomes and refunds T4, the waiting list T5, the waiting room T6, the BFF routes T7. Everything
below was run, against real Postgres and Kafka through `libs/testing`, not reasoned about.

## 0. Three processes, one database

| Process | Entry | Serves |
| --- | --- | --- |
| API | `node dist/main.js`, `PORT` (3004 in `.env.example`) | the studio's `setDatePrices`, `openCapacityTier`, `getDateTicketsPane`; the storefront's `refreshDateAvailability`; `/health/liveness`, `/health/readiness` |
| consumer | `node dist/consumer.js` | `arthome.catalog.date`, retrying on `arthome.ticketing.retry`, dead-lettering to `arthome.ticketing.dlq` |
| sweeper | `node dist/sweeper.js` | the availability publisher (§0e); T3's hold expiry joins it |

All three read `DATABASE_URL` through `libs/config` (`NODE_ENV` required, never defaulted), close
their pool on SIGTERM, and are booted as their entry points boot them by `src/boot.itest.ts`. The API
binds `DenyInProductionGuard`, the envelopes and the validation pipe (`src/edge-providers.ts`), as
catalog does. Its readiness fails only on the database; the slot, the publication and the outbox
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
- **The technical provision** is `technicalProvisionOf` (`technical-provision.ts`): core's
  threshold, `requiresTechnicalProvision`, and a deadline `PROVISION_REVISION_HOURS` before the
  start, once catalog has stated one. It is served and published, never refused (§3).
- **The version** counts every load-modify-save, a studio command's or a consumed fact's: a studio
  screen that did not see a reschedule or the lock is stale like any other (accepted by the lead,
  2026-09-27). A command names it (`expectedVersion`); a fact is guarded by its own `occurred_at` per
  group (the start, the outcome), and the lock happens once. Events are stated at ticketing's clock,
  catalog's instant kept only as the guard, so a skew between the two cannot reorder one stream.

## 0b. The studio's operations

`PUT /v1/dates/:dateId/prices`, `POST /v1/dates/:dateId/capacity-tiers` and
`GET /v1/dates/:dateId/panes/tickets`, in `openapi/studio.yaml`'s shapes.

- The two commands take an `Idempotency-Key` (`runIdempotentlyVersioned`: the version at the
  envelope's root), answer the pane read off the row inside their transaction, and refuse 409 with
  the domain's code: `state.conflict` with `version`, `date.prices_locked`, `capacity.tier_must_widen`.
- `setDatePrices` refuses 400 naming `tiers` a tier sent twice or two currencies in one sale; the
  aggregate holds the one currency itself for any other writer (§3).
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
max-age=15`, the operation's freshness, transport.md §5.9), and carries `validUntil` 60 s after
`servedAt`, `AVAILABILITY_VALID_SECONDS`, whose number data-model §3.1 owns (§3). **Only a sale on
sale is served** (`on_sale`): before it opens, and once a cancellation or an interruption closed it,
the read answers 404 rather than seats nobody can buy.

## 0d. What ticketing takes from catalog

`src/date-sales/catalog-date-messages.ts` reads `arthome.catalog.date` into one command,
`ApplyCatalogDateFact`, whose handler claims `processed_message` in its transaction.

| Type | Fact | Effect |
| --- | --- | --- |
| `catalog.date.drafted.v1` | `drafted` | opens the `DateSales`; a second draft of the date is `superseded` |
| `catalog.publication.engaged.v1` | `lock`, when it engages the prices | locks them, opens the sale, restates `pricing_changed` |
| `catalog.date.scheduled.v1`, `.rescheduled.v1` | `start` | records the start; restates `capacity_set` when a provision's deadline moves |
| `catalog.date.outcome_declared.v1` | `outcome` | records it; `cancelled` and `interrupted` close the sale (ADR §8), refunds and credits T4 |

Anything else is `ignored`, and so is an outcome member this build does not know (critical rule 10).
**A fact about a date not opened here is retried, not dead-lettered**: catalog drafts first, so only
a retry topic holding the draft explains it, and the draft is ahead of it on their key's retry
partition. Unreadable bytes and a missing or malformed `message-id` are dead-lettered at attempt 0.
A draft older than the topic's retention is never read: see the deployment order (§0).

## 0e. The events, and the availability publisher

- `date_sales.capacity_set` and `date_sales.pricing_changed` are outbox rows written by the command
  from the aggregate's uncommitted events (`date-sales-integration-events.ts`), in the order it
  applied them, on the date's key.
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
- **A date that cannot be published holds back no other** (correctness review): its failure is
  logged, its `failed_at` recorded, and it waits `AVAILABILITY_PUBLISH_RETRY_SECONDS` (30) before it
  is tried again, behind the others, still marked; a publication clears it.
- **It runs in the sweeper process, its own, on a one-second loop**, not in the consumer and not on
  BullMQ. The sweeper needs Postgres alone: in the consumer's process a Kafka outage would stop it
  at boot, and on a queue a Redis outage would; T3's hold expiry lives here and must return capacity
  through either (ADR §4: Redis down, correctness holds). A loop rather than `@Interval`
  (`nestjs-scheduling-events`): no overlapping passes, and `beforeApplicationShutdown` awaits the pass
  in flight. Every replica may run it; `SKIP LOCKED` hands each its own dates, and a missed tick
  loses nothing (`nestjs-queues`' Decide: the recurring work stays in the database it reads). A pass
  scans the opened sales against their publication rows with no index of its own: fine at this
  scale, to measure in T3's load test.

## 0f. Conventions

Catalog's, `apps/catalog/HANDOVER.md` §0f, through the same libraries: `TicketingTransactions` is
`TransactionRunner` over `ticketingTransactionOf`, the repository tracks with `AggregateTracker` and
saves with `saveVersioned`, commands answer through `runIdempotentlyVersioned`, consumers claim with
`claimMessage`. Domain events reach the `EventBus` after the commit and nothing subscribes to them.
Refusals: the aggregate throws core's `DomainError`; the studio handlers wrap it in `asConflict`
(409), the consumer maps it (retry for an unknown date, dead-letter otherwise).

## 1. What proves it

| Suite | What |
| --- | --- |
| `date-sales.aggregate.spec.ts` | 19 cases, plain Vitest, core never mocked |
| `date-sales.itest.ts` | the commands through the buses: replay, key reuse, stale version, two commands from one version, the lock, the counters as deltas under a hold, the provision's deadline restated, domain events after commit only, the outbox's rows in order |
| `catalog-date-consumer.itest.ts` | real Kafka: duplicate, superseded start and outcome, ignored, a fact before its draft retried then applied, poison dead-lettered |
| `publish-due-availability.itest.ts` | the rate bound (a seat every 500 ms for 12 s: four publications), selling out and back at once, a closing, a draft unpublished, a date a command holds published without waiting, `SKIP LOCKED` and four racing passes, a move during a publication neither waiting nor lost, the hold's wait behind a hundred-date pass, a date that cannot be published set aside and tried again |
| `migrations/availability-publication.itest.ts` | the publication table's migration on a database that already holds dates |
| `date-sales.http.itest.ts` | the routes over HTTP through the modules the API boots |
| `catalog-exchange.itest.ts` | catalog and ticketing read each other's real outbox rows, shaped as the connector routes them: a draft opens the sale, ticketing's capacity and price complete catalog's checklist, catalog publishes, the prices lock |
| `boot.itest.ts` | the three root modules |

**`catalog-exchange.itest.ts` imports fourteen of catalog's internal modules by relative path**, no
manifest recording it (architecture review M5), and that is accepted, in a test only. Its point is
that each service's own consumer code reads the other's real outbox rows; a shared fixture or a
contract test on the proto alone would prove only that both sides read the same schema, not that
catalog's checklist rules accept what ticketing's aggregate writes. The cost is known: a rename
inside catalog breaks this suite, which is where it should be noticed. No production code of
either service imports the other.

## 2. What T3 inherits

- The hot decrement: `UPDATE date_sales SET seats_available = seats_available - $q,
  availability_moves = availability_moves + 1 WHERE date_id = $1 AND on_sale AND seats_available >=
  $q`, executed by the repository and registered with `AggregateTracker.writtenUnversioned`; it must
  update the tracker's stored snapshot too, or a later save in the transaction applies the delta
  again. The publisher takes no lock it could wait on.
- `seats_sold` moves at payment by the same kind of statement; the fill rate reads it.
- **`findById` always loads `FOR UPDATE`**: the hold path must not reuse it (ADR §11: no lock across
  application code), but load unlocked, or not at all, before its conditional decrement.
- **`on_sale` has no end in time**: prices locked and not closed. A decrement on `on_sale` alone
  would sell after the show and its replay are over, unless T3 bounds its WHERE by the date's window
  or a sweeper closes the sale.
- **The stored snapshot moves both ways**: if T3 also moves the aggregate's counters after its
  decrement, it moves the repository's stored snapshot by the same amount, or the next save applies
  the delta a second time.
- The purchase claims its idempotency key in tx A and answers in tx B, which `runIdempotently`
  (one transaction) does not cover: settle it in T3's first change, or key the purchase on
  `seat_order` alone (libs review L1).
- The sweeper process for hold expiry: a second loop beside `AvailabilityPublisher`.
- Topics `arthome.ticketing.order` (6, `order_id`) and `.account` (3) are provisioned.
- For T4: refunds run on BullMQ (ADR §8), which needs Redis; the sweeper stays on Postgres alone,
  so those workers need a process of their own or the consumer's. T4 decides and records it here.

## 3. Gaps, reported rather than worked around

Three are core's to add, and accepted as interim by the lead on 2026-09-27, who takes them to
arthome-core:

- **a constant for the availability read's 60 s**: until then `AVAILABILITY_VALID_SECONDS`, naming
  data-model §3.1 as its owner;
- **a refusal rule for `date.technical_provision_required`** (when `openCapacityTier` refuses), with
  a function for the revision deadline and one for the penalty exposure: until then the provision is
  served and published, never refused, its deadline counted back with core's constant. **This
  interim blocks lifting `DenyInProductionGuard` from the studio routes** (architecture review M2):
  until the refusal exists, a studio could widen past 10,000 seats inside the last 72 hours;
- **a rule that a sale's tiers share one currency**, which core's `lowestActivePrice` assumes: until
  then `DateSales.setPrices` holds it locally (`assertOneCurrency`, refused with core's
  `money.currency_mismatch`, 409 through `asConflict`), and the request schema refuses it earlier,
  400 `api.schema_invalid` naming `tiers`, so no HTTP caller reaches the aggregate's refusal.

Known and left, each judged:

- `market_id` and the service-fee schedule have no source yet; neither is stored.
- **Catalog's service glue is copied** (architecture review M4): `itest/http-app.ts`,
  `assert-never.ts`, `edge-providers.ts`, `writeTicketingEvent`, `notFound`, `asConflict`, the
  consumer host and `frozen`. They move to `libs/` in a feature of their own after T2.
- **`CLOCK` is provided in each feature module and in `EDGE_PROVIDERS`** (N2): catalog's pattern,
  harmless while `SystemClock` is stateless; one provider per process root comes with the glue.
- **`pricesLockedAt` is catalog's engagement instant**, not ticketing's consumption (correctness
  nit 2): the studio shows one lock instant, and the contract's examples give catalog's publication
  `pricesLockedAt` and ticketing's `lockedAt` the same value. A price change applied between the two
  instants is what the lock then holds.
- **Two services' clocks order one date's facts** (correctness nit 3): the API's for
  `pricing_changed` and `capacity_set`, the sweeper's for `availability_changed`, compared by
  latest-wins consumers. It takes a skew larger than the seconds between two facts, NTP makes that
  unlikely, and catalog does the same: a platform pattern, not T2's alone.
- Proven on the development stack on 2026-09-27 at 630dbd5 (AGENTS.md); the fixes since are proven
  on containers only.
