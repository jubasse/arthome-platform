### The ticketing purchase path

The storefront's seat operations run on ticketing's API, the BFF routes being T7's; the payment
provider is the fake adapter, bound by default (`adr-payments.md` §4), which confirms every intent
at once on the running stack:

```
POST /v1/dates/:dateId/seat-quote   { tier, quantity }                 x-arthome-deadline required
POST /v1/orders/seats               { dateId, tier, quantity, expectedTotal }   Idempotency-Key required,
                                                    X-Arthome-Late-Entry-Acknowledged after the start
GET  /v1/orders/:orderId                                                x-arthome-deadline required
POST /v1/seats/:seatId/cancel       { cancelReasonCode? }               Idempotency-Key required
POST /v1/seats/:seatId/refund       { refundReasonCode, partialAmountMinor? }   the studio's; Idempotency-Key
```

A seat's cancellation and its refund, and the provider's refund and dispute webhooks, are
`apps/ticketing/HANDOVER.md` §0o.

`purchaseSeat` answers 201 with the tickets and the order once paid, 202 with the payment handoff
while the buyer has to act, 409 `order.sold_out`, `order.price_stale` or `order.payment_declined`,
and 503 when the provider does not answer; a replay under its key answers the first answer again.
Seats sell until thirty minutes after the live's start (D-089): from the start the quote carries
`lateEntry`, and a purchase without `X-Arthome-Late-Entry-Acknowledged: true` is refused 409
`order.late_entry_unacknowledged` before any seat is taken, a retry under its key included; past the
cutoff, the quote and the purchase answer 409 `order.sales_closed`.
The provider's webhooks arrive on `POST /v1/payments/webhook`, verified on their raw bytes, recorded
in `stripe_event_inbox` and answered at once; the API process's payment worker applies them every
second. A payment confirmed after its hold expired with no seat left owes its refund (D-082), and an
expired order its intent's cancellation: rows in Postgres, which the worker process's relay
enqueues and its queues make, rate-limited and retried, then given up on with a dead row that
`ops:check ticketing` reports (`apps/ticketing/HANDOVER.md` §0j, §0k, §0m).

The capacity invariant is proven by `orders/capacity.itest.ts` on a real Postgres (adr-ticketing.md
§3): 300 purchases at once on 100 seats hold exactly 100, never below zero, and all 100 come back at
expiry; measured over three runs, the 300 took 574, 634 and 946 ms with the fake provider and a pool
of ten. The load test at 10,000 buyers a minute is T6's.

Proven on the running stack on 2026-09-29 at 040190f, the four new migrations run on the database
that already held T2's dates, ticketing's three processes started from that build, a date drafted,
scheduled and engaged by catalog's facts sent on `arthome.catalog.date`, 5 seats at 24 EUR:

| Check | Result |
| --- | --- |
| `quoteSeat` for 3 | 200, one `tier` line of 7200 EUR, `validUntil` 60 s out |
| `purchaseSeat` for 3 | 201 in 40 ms: three seats `ATH-XXXXXX`, their cancel deadline an hour before the start, order `ATH-2026-00001` paid |
| the same key again | 201 in 5 ms, `Idempotency-Replayed: true`, the body byte for byte |
| 3 more under a new key | 409 `order.sold_out`, 2 seats left |
| `arthome.ticketing.order` | `order.paid`, key the order id, the request's `traceparent` |
| `arthome.ticketing.date_sales` | three `seat.activated` on the date's key, then the sweeper's `availability_changed` 0.25 s after the purchase |
| a webhook forged, then a genuine `payment_failed` twice | 401; 200 recorded; 200 `duplicate: true`; applied by the worker within 2.5 s, the paid order left paid |
| SIGTERM to the three | stopped, no ticketing connection left in `pg_stat_activity` |

Proven again on 2026-09-29 at d621b51, after both reviews' fixes, the three migrations
`1790440900000` to `1790441100000` run on that database, the three processes rebuilt, one date
started ten minutes before and one thirty-one minutes before, each opened by catalog's facts:

| Check | Result |
| --- | --- |
| a purchase on a date not started | 201, the order paid |
| the quote on the started date | 200 with `lateEntry`: `minutesElapsed` 10 and `salesEndAt` 30 min after the start |
| a purchase there, without then with `X-Arthome-Late-Entry-Acknowledged: true` | 409 `order.late_entry_unacknowledged` with the three facts, no hold nor order left; then 201 |
| the date past its cutoff | closed by the sweeper at its end, its last availability published; purchase and quote 409 `order.sales_closed` with `salesEndAt` |

The worker beside the three (HANDOVER §0m) was proven on 2026-10-06 at PT0's PR B, on an isolated
copy of this stack: compose's own services under `docker compose -p pt0-proof` with an override
publishing Postgres, Kafka and Redis on ports of their own, the migrations to `1790441200000` run on
an empty `ticketing`, the topics provisioned (`COMPOSE_PROJECT_NAME=pt0-proof pnpm run
provision:topics`: the tool runs `docker compose exec kafka`, so without it the shared stack's
broker is the one provisioned), the four processes started from that build. Two failed orders whose
holds had expired were seeded on a date with no seat left, then the fake's signed
`payment_intent.succeeded` was posted for each:

| Check | Result |
| --- | --- |
| the first confirmation | 200; applied by the API's payment worker, its refund owed under `refund:{orderId}` with the webhook's `traceparent`; made by the worker 1.1 s after the webhook was answered, the order `refunded`, one `order.refunded` under that trace |
| Redis paused 28 s, the second confirmation posted | 200, readiness unchanged; the refund owed and not enqueued; each relay pass failed on `Command timed out` within its 2 s, nine in all; `ops:check ticketing` answered `provider_call_queues` degraded, `provider_calls_dead` up |
| Redis resumed | the second refund made 37 ms later, once, one `order.refunded`; `provider_call_queues` up, every count 0 |
| SIGTERM to the four | all exited, no ticketing connection left in `pg_stat_activity`; then `down -v` |

The second refund ran from the job its failed pass had sent: the commands sat on the socket during
the pause and ran when Redis came back, so the row was made without ever being stamped, which is the
crash between the add and the commit the job ids absorb.

Tx A, the provider call between two transactions, tx B, and why the key is the order's, are
`apps/ticketing/HANDOVER.md` §0h. A hold nobody paid expires in the sweeper within a second of its
instant, its seats back and its order failed (§0i). Run `migration:run` for `1790440500000` to
`1790440900000` with the processes stopped (four since the worker), as for every ticketing
migration; the last one writes each scheduled sale's end, and the sweeper closes those already past
it on its first pass.

