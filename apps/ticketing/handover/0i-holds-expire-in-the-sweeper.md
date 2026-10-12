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

