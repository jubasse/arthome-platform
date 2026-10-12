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

