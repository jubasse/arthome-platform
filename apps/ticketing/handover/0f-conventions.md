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

