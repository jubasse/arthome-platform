### The ticketing date sales path

`ticketing` runs four processes from `apps/ticketing`, all on its own database `ticketing`: the API
(`node dist/main.js`, `PORT=3004` in `.env.example`), the catalog consumer (`node dist/consumer.js`),
the sweeper (`node dist/sweeper.js`), which publishes `availability_changed`, expires the holds
nobody paid, closes each sale thirty minutes after its start (D-089, HANDOVER §0l), settles a
cancelled date's refunds and an interrupted one's credits and ends its waiting list (HANDOVER §0n),
ends each waiting list's priority window (HANDOVER §0p), and needs Postgres alone, and the worker (`node dist/worker.js`, `REDIS_URL`), which makes every call owed to
the payment provider from BullMQ's queues (HANDOVER §0m) and alone holds Redis. Its connector is
`infra/debezium/ticketing-outbox.json`, registered with the loop above.

A date catalog drafts is opened in ticketing by the consumer; the studio then gives it capacity and
prices, each with an `Idempotency-Key` and the version the pane served:

```
POST /v1/dates/:dateId/capacity-tiers   { additionalCapacity, expectedVersion, notifyWaitlist }
PUT  /v1/dates/:dateId/prices           { expectedVersion, tiers: [{ tier, amountMinor, currencyCode, active }] }
PUT  /v1/dates/:dateId/technical-provision  { provisionedCapacity, expectedVersion }; past core's TECHNICAL_PROVISION_THRESHOLD
GET  /v1/dates/:dateId/panes/tickets
GET  /v1/dates/:dateId/availability     x-arthome-deadline required; 404 unless on sale
```

When an `included` date's live ends, catalog's `catalog.replay.state_changed.v1` (`pending`) gives
each of its active seats one `replay_access` row, and a withdrawal revokes them (HANDOVER §0r).

The storefront's waiting list on a sold-out date (D-083, HANDOVER §0p), for the token's account:

```
PUT    /v1/dates/:dateId/waitlist   Idempotency-Key; 409 waitlist.not_sold_out while public seats remain
DELETE /v1/dates/:dateId/waitlist   Idempotency-Key; { joined: false }, replayed or not
GET    /v1/dates/:dateId/waitlist   x-arthome-deadline required; state, and the window while notified
```

With `notifyWaitlist: true` and someone on the list, a tier becomes a priority pool only the
notified accounts buy for `WAITLIST_PRIORITY_HOURS`, named in `waitlist.notified` on
`arthome.ticketing.date_sales`; the public still sees the date sold out until the sweeper ends the
window and puts the rest on sale.

Each command writes `capacity_set` or `pricing_changed` on `arthome.ticketing.date_sales`, keyed by
the date, which catalog's checklist consumer reads: with them, catalog's by-hand
`arthome.ticketing.date_sales` facts above are no longer needed. Publishing the date in catalog
locks the prices in ticketing (`date.prices_locked` from then) and opens the sale; the sweeper then
publishes the availability at most every five seconds per date, a sell-out at once. What each part
does and why is `apps/ticketing/HANDOVER.md`.

**Deploy ticketing's consumer before the first date is drafted in production.** It opens a sale only
from `catalog.date.drafted`, and reads `arthome.catalog.date` from the beginning of what the topic
keeps: a date drafted more than the topic's retention (168 h) before the group first reads it never
opens, and every later fact about it is retried, then dead-lettered.

Proven on the running stack on 2026-09-27, the ticketing database created by hand (the init script
runs only on an empty data directory), its migration run, its connector registered, the four new
topics provisioned, catalog's API and consumer and ticketing's three processes running:

| Check | Result |
| --- | --- |
| a date drafted in catalog | opened in ticketing within 5 s through Debezium: version 1, no capacity, no price; the backlog of `arthome.catalog.date` opened the dates already drafted |
| `openCapacityTier` 300, then `setDatePrices` full 2500 and reduced 1800 EUR | 200, versions 2 and 3; a write naming version 2 again, 409 `state.conflict` with version 3 |
| catalog's checklist | `capacity` and `at_least_one_active_price` satisfied by ticketing's own events, no fact sent by hand |
| publishing in catalog | ticketing locked the prices and opened the sale: 300 seats; `setDatePrices` then 409 `date.prices_locked` with `lockedAt` |
| the public availability | 200 with `validUntil` 60 s out; without `x-arthome-deadline`, 400 |
| ticketing's outbox for the date | `capacity_set`, `pricing_changed`, `pricing_changed` (the lock), then `availability_changed` from the sweeper half a second after the sale opened |

That run was at 630dbd5, before the reviews' fixes. Proven again at e0967b4, after them and after
core's rules and D-088, the three new migrations run on the database that already held those dates:

| Check | Result |
| --- | --- |
| a tier past 10,000 with no provision | 409 `date.technical_provision_required`, naming the threshold, the capacity and `revisableUntil` |
| `setTechnicalProvision` 12,000, then a tier to 12,000 | 200 and 200; both wrote a `capacity_set`, and the sweeper published the new availability 0.4 s later |
| a provision of 11,000 under 12,000 open | 409 `date.provision_below_capacity` |
| prices in EUR and CHF on a fresh draft | 409 `date.prices_currency_mismatch`, naming the tier and both currencies |
| the date cancelled in catalog | the sale closed in ticketing: the availability read 404, a new tier 409 `state.conflict` naming the outcome, and a last `availability_changed` of 0 seats, `sold_out` false, 0.7 s after the cancellation |

Proven a third time on 2026-09-27 at 70307cb, after the re-review's fixes, their migration `1790440400000` run
on the database that already held those dates. The unpublishable date is a hand edit, the same one
the container suite makes: no validated write stores such a price.

| Check | Result |
| --- | --- |
| two tiers on a date on sale, one second apart | the first published 0.9 s after it, the second 5.2 s after the first publication, as the interval holds it |
| a date whose price core refuses (`amountMinor` 1.5), moved | `money.amount_not_integer` logged, `failed_at` set; tried again every 10.1 s; a tier opened meanwhile on another date published in the same pass |
| that price put back | published at the next retry, `failed_at` cleared |
| a date on sale cancelled in catalog | the sale closed in ticketing 0.3 s after catalog's answer; its closing, no longer on sale, reached through `closing_due` and published once 1.6 s later: 0 seats, `sold_out` false; the availability read 404 |

