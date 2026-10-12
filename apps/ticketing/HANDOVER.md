# `ticketing` — handover: a date's commercial face (T2), its holds, orders and payment (T3)

arthome-core `adr-ticketing.md` (accepted, D-077 to D-083) cuts the first slice into phases. T2 built
the service itself and `DateSales` (`data-model.md` §3.1), §0 to §0f; T3 the holds, the orders and
their payment, §0g onwards. Outcomes and refunds are T4, the waiting list T5, the waiting room T6,
the BFF routes T7; T4 opened with the worker process and its queues (§0m). Everything below was
run, against real Postgres, Kafka and Redis through `libs/testing`, not reasoned about.

## 0. Four processes, one database

| Process | Entry | Serves |
| --- | --- | --- |
| API | `node dist/main.js`, `PORT` (3004 in `.env.example`) | the studio's `setDatePrices`, `openCapacityTier`, `setTechnicalProvision`, `getDateTicketsPane`; the storefront's `refreshDateAvailability`, `quoteSeat`, `purchaseSeat`, `getOrder` (§0h); a seat's `cancelSeat` and `refundSeat` (§0o); the waiting list's `joinWaitlist`, `leaveWaitlist`, `getWaitlistRegistration` (§0p); the provider's webhooks and the payment worker that applies them (§0j); `/health/liveness`, `/health/readiness` |
| consumer | `node dist/consumer.js` | `arthome.catalog.date`, retrying on `arthome.ticketing.retry`, dead-lettering to `arthome.ticketing.dlq` |
| sweeper | `node dist/sweeper.js` | the availability publisher (§0e), the hold expiry (§0i), the closing of sales whose time is over (§0l), the settlement of a date's cancellation or interruption (§0n) and the end of each priority window (§0p), Postgres alone |
| worker | `node dist/worker.js`, `REDIS_URL` | every call owed to the payment provider, a refund (§0k) or an intent's cancellation (§0i), made from BullMQ's queues, and the relay that feeds them (§0m); Postgres and Redis |

**Stop all four before `migration:run`.** A migration may drop a column the running build still
reads (`1790440100000` moved three `date_sales` columns to the publisher's table; `1790441200000`
moved the refunds to `order_refund`): a rolling restart would fail their reads, and the consumer
could dead-letter facts it can no longer apply.

## Sections

The sections are cited as `apps/ticketing/HANDOVER.md §0x`; this table resolves each one. §0 holds the
process table and the migration rule above, and the rest of it is in its file.

| § | title | file |
| --- | --- | --- |
| §0 | Four processes, one database | [`handover/0-four-processes-one-database.md`](handover/0-four-processes-one-database.md) |
| §0a | `DateSales` | [`handover/0a-datesales.md`](handover/0a-datesales.md) |
| §0b | The studio's operations | [`handover/0b-the-studios-operations.md`](handover/0b-the-studios-operations.md) |
| §0c | The storefront's `refreshDateAvailability` | [`handover/0c-the-storefronts-refreshdateavailability.md`](handover/0c-the-storefronts-refreshdateavailability.md) |
| §0d | What ticketing takes from catalog | [`handover/0d-what-ticketing-takes-from-catalog.md`](handover/0d-what-ticketing-takes-from-catalog.md) |
| §0e | The events, and the availability publisher | [`handover/0e-the-events-and-the-availability.md`](handover/0e-the-events-and-the-availability.md) |
| §0f | Conventions | [`handover/0f-conventions.md`](handover/0f-conventions.md) |
| §0g | The payment ports (T3) | [`handover/0g-the-payment-ports-t3.md`](handover/0g-the-payment-ports-t3.md) |
| §0h | Holds, orders and the purchase (T3) | [`handover/0h-holds-orders-and-the-purchase.md`](handover/0h-holds-orders-and-the-purchase.md) |
| §0i | Holds expire in the sweeper (T3) | [`handover/0i-holds-expire-in-the-sweeper.md`](handover/0i-holds-expire-in-the-sweeper.md) |
| §0j | Webhooks, recorded then applied (T3) | [`handover/0j-webhooks-recorded-then-applied-t3.md`](handover/0j-webhooks-recorded-then-applied-t3.md) |
| §0k | A payment confirmed after its hold expired (T3, D-082) | [`handover/0k-a-payment-confirmed-after-its.md`](handover/0k-a-payment-confirmed-after-its.md) |
| §0l | Seat sales end thirty minutes after the start, and a late buyer is told (T3, D-089) | [`handover/0l-seat-sales-end-thirty-minutes.md`](handover/0l-seat-sales-end-thirty-minutes.md) |
| §0m | The worker process: every provider call on BullMQ (T4, PT0) | [`handover/0m-the-worker-process-every-provider.md`](handover/0m-the-worker-process-every-provider.md) |
| §0n | A date's outcomes: refunds, credits, the postponement (T4, PT1) | [`handover/0n-a-dates-outcomes-refunds-credits.md`](handover/0n-a-dates-outcomes-refunds-credits.md) |
| §0o | A seat's cancellation and refund, and the provider's refund and dispute webhooks (T4, PT2) | [`handover/0o-a-seats-cancellation-and-refund.md`](handover/0o-a-seats-cancellation-and-refund.md) |
| §0p | The waiting list and its priority window (T5, PT3) | [`handover/0p-the-waiting-list-and-its.md`](handover/0p-the-waiting-list-and-its.md) |
| §0q | The race suite and the drills (T4, PT4) | [`handover/0q-the-race-suite-and-the.md`](handover/0q-the-race-suite-and-the.md) |
| §0r | The `included` replay accesses (RT1) | [`handover/0r-the-included-replay-accesses-rt1.md`](handover/0r-the-included-replay-accesses-rt1.md) |
| §1 | What proves it | [`handover/1-what-proves-it.md`](handover/1-what-proves-it.md) |
| §2 | What T4 inherits | [`handover/2-what-t4-inherits.md`](handover/2-what-t4-inherits.md) |
| §3 | Gaps | [`handover/3-gaps.md`](handover/3-gaps.md) |
